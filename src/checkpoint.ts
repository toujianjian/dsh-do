/**
 * File-per-loop checkpoint store. Each loop owns one `<root>/loop-<id>.json`;
 * every write is an atomic whole-file publish (same-directory temp + fsync +
 * rename), and writes to one file are serialized through an in-flight chain so
 * concurrent transitions cannot interleave whole-file replacements.
 *
 * @module dsh-do/checkpoint
 */
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, lstat, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { LoopPauseReasonCode, LoopPhase, LoopState } from './loop.js'
import { MAX_TIMER_DELAY_MS } from './loop.js'

/** On-disk envelope for one loop checkpoint. */
interface CheckpointFile {
	readonly version: 1
	readonly loop: LoopState
}

const FILE_PREFIX = 'loop-'
const FILE_SUFFIX = '.json'

/** Serialize one loop to its checkpoint document. */
export function serializeCheckpoint(loop: LoopState): string {
	const document: CheckpointFile = { version: 1, loop }
	return `${JSON.stringify(document, null, 2)}\n`
}

const PHASES: readonly LoopPhase[] = ['active', 'completed', 'blocked', 'cancelled']

/**
 * Render an untrusted JSON value for a diagnostic without trusting it.
 *
 * `String(value)` runs a coercion that a parsed document controls
 * (`{"toString": null}` throws a TypeError), and a throwing diagnostic would
 * escape the tolerant parser and abort the whole restore. Only the JSON scalar
 * domain is echoed; objects and arrays are described by kind instead, because
 * their exact shape is rarely the point of the message and can be arbitrarily
 * large.
 *
 * @param value - a value read out of a parsed checkpoint document.
 * @returns a short, safe description.
 */
function describeValue(value: unknown): string {
	if (typeof value === 'string') return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value)
	if (typeof value === 'number') return Object.is(value, -0) ? '-0' : String(value)
	if (typeof value === 'boolean') return String(value)
	if (value === null) return 'null'
	if (Array.isArray(value)) return 'an array'
	return typeof value === 'object' ? 'an object' : typeof value
}

/** Accepted pause causes; a record naming another one is corrupt. */
const PAUSE_CODES: readonly LoopPauseReasonCode[] = ['round-cancelled', 'round-aborted', 'max-tokens', 'agent-error', 'driver-failed', 'restart']

/** Tolerant parse of one checkpoint file; returns the loop or a reason. */
export function parseCheckpoint(
	text: string,
	fileName: string,
): { ok: true; loop: LoopState } | { ok: false; error: string } {
	let document: unknown
	try {
		document = JSON.parse(text)
	} catch {
		return { ok: false, error: `file ${fileName} is not valid JSON` }
	}
	if (typeof document !== 'object' || document === null) {
		return { ok: false, error: `file ${fileName} is not a JSON object` }
	}
	const { version, loop } = document as { version?: unknown; loop?: unknown }
	if (version !== 1) return { ok: false, error: `file ${fileName} has unsupported version ${describeValue(version)}` }
	if (typeof loop !== 'object' || loop === null) return { ok: false, error: `file ${fileName} has no loop record` }
	const state = loop as Record<string, unknown>
	if (typeof state.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(state.id) || typeof state.sessionId !== 'string' || state.sessionId.length === 0 || typeof state.objective !== 'string') {
		return { ok: false, error: `file ${fileName} has an invalid loop record` }
	}
	if (typeof state.maxRounds !== 'number' || !Number.isSafeInteger(state.maxRounds) || state.maxRounds < 1) {
		return { ok: false, error: `file ${fileName} has an invalid maxRounds` }
	}
	if (typeof state.phase !== 'string' || !PHASES.includes(state.phase as LoopPhase)) {
		return { ok: false, error: `file ${fileName} has an invalid phase` }
	}
	if (typeof state.armed !== 'boolean') return { ok: false, error: `file ${fileName} has an invalid armed flag` }
	if (typeof state.roundsStarted !== 'number' || !Number.isSafeInteger(state.roundsStarted) || state.roundsStarted < 0) {
		return { ok: false, error: `file ${fileName} has an invalid roundsStarted` }
	}
	const blockedReason = state.blockedReason
	if (blockedReason !== undefined) {
		const reason = blockedReason as Record<string, unknown>
		if (typeof reason !== 'object' || reason === null || Array.isArray(reason) || typeof reason.code !== 'string' || typeof reason.message !== 'string') {
			return { ok: false, error: `file ${fileName} has an invalid blockedReason` }
		}
	}
	// A recorded pause explains why an active loop stopped continuing. A damaged
	// one would make the status surface invent a cause or show none, so a wrong
	// shape is a corrupt record rather than a field to drop.
	const pausedReason = state.pausedReason
	if (pausedReason !== undefined) {
		const reason = pausedReason as Record<string, unknown>
		if (
			typeof reason !== 'object' ||
			reason === null ||
			Array.isArray(reason) ||
			!PAUSE_CODES.includes(reason.code as LoopPauseReasonCode) ||
			typeof reason.message !== 'string' ||
			typeof reason.at !== 'number' ||
			!Number.isFinite(reason.at)
		) {
			return { ok: false, error: `file ${fileName} has an invalid pausedReason` }
		}
		if (state.armed === true) return { ok: false, error: `file ${fileName} records a pause while armed` }
		if (state.phase !== 'active') return { ok: false, error: `file ${fileName} records a pause on a ${describeValue(state.phase)} phase` }
	}
	// Optional payloads are either a string or absent; a wrong type is a corrupt
	// record, not a value to silently drop. Accepting it would let a damaged file
	// report a loop whose summary/reason vanished without any diagnostic.
	for (const key of ['completedSummary', 'cancelledReason'] as const) {
		if (state[key] !== undefined && typeof state[key] !== 'string') {
			return { ok: false, error: `file ${fileName} has an invalid ${key}` }
		}
	}
	// `armed` is automatic-continuation authority; a terminal phase has already
	// revoked it. A record claiming both would make loop_status report an armed
	// completed loop and mislead the model's next decision.
	if (state.phase !== 'active' && state.armed === true) {
		return { ok: false, error: `file ${fileName} has an armed ${describeValue(state.phase)} phase` }
	}
	// A cadence is a positive whole number of milliseconds or absent. A wrong
	// type is a corrupt record: silently dropping it would silently turn a paced
	// loop into an unpaced one that burns its whole round budget back to back.
	const intervalMs = state.intervalMs
	if (intervalMs !== undefined && (typeof intervalMs !== 'number' || !Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > MAX_TIMER_DELAY_MS)) {
		return { ok: false, error: `file ${fileName} has an invalid intervalMs` }
	}
	for (const key of ['startedAt', 'updatedAt'] as const) {
		if (typeof state[key] !== 'number' || !Number.isFinite(state[key])) return { ok: false, error: `file ${fileName} has an invalid ${key}` }
	}
	return {
		ok: true,
		loop: {
			id: state.id as LoopState['id'],
			sessionId: state.sessionId,
			objective: state.objective,
			maxRounds: state.maxRounds,
			...(intervalMs === undefined ? {} : { intervalMs }),
			phase: state.phase as LoopPhase,
			armed: state.armed,
			...(pausedReason === undefined
				? {}
				: {
						pausedReason: {
							code: (pausedReason as { code: LoopPauseReasonCode }).code,
							message: (pausedReason as { message: string }).message,
							at: (pausedReason as { at: number }).at,
						},
					}),
			roundsStarted: state.roundsStarted,
			...(blockedReason === undefined
				? {}
				: { blockedReason: { code: (blockedReason as { code: string }).code, message: (blockedReason as { message: string }).message } }),
			...(typeof state.completedSummary === 'string' ? { completedSummary: state.completedSummary } : {}),
			...(typeof state.cancelledReason === 'string' ? { cancelledReason: state.cancelledReason } : {}),
			startedAt: state.startedAt as number,
			updatedAt: state.updatedAt as number,
		},
	}
}

/** Durably replace `path` with `data` (same-directory temp + fsync + rename). */
async function writeAtomic(path: string, data: string): Promise<void> {
	const tmp = join(dirname(path), `.${randomUUID()}.tmp`)
	try {
		const handle = await open(tmp, 'wx', 0o600)
		try {
			await handle.writeFile(data, 'utf8')
			await handle.sync()
		} finally {
			await handle.close()
		}
		await rename(tmp, path)
	} catch (error) {
		await rm(tmp, { force: true })
		throw error
	}
}

/** Optional diagnostic sink for checkpoint problems. */
export interface LoopStoreOptions {
	readonly onError?: (message: string) => void
}

/**
 * File-per-loop checkpoint store. Reads are a tolerant directory scan; writes
 * are atomic and serialized per file.
 */
export class LoopStore {
	private readonly chains = new Map<string, Promise<void>>()

	constructor(
		private readonly root: string,
		private readonly options: LoopStoreOptions = {},
	) {}

	private path(loopId: string): string {
		if (!/^[A-Za-z0-9_-]+$/.test(loopId)) throw new Error('invalid checkpoint loop id')
		return join(this.root, `${FILE_PREFIX}${loopId}${FILE_SUFFIX}`)
	}

	/**
	 * Load every checkpoint file; returns loops keyed by session id.
	 *
	 * Restore is the one path where a single bad entry can take down every
	 * healthy one, so each file is isolated three ways: only regular files are
	 * opened (a FIFO or device named `loop-*.json` would otherwise block or
	 * stream forever, freezing startup before the loop tools are registered),
	 * read failures are reported and skipped, and — belt and braces — an
	 * unexpected throw from the parser is skipped rather than propagated, so no
	 * single record can cost the rest of the session's loops.
	 */
	async load(): Promise<Map<string, LoopState>> {
		const result = new Map<string, LoopState>()
		let entries: string[]
		try {
			entries = await readdir(this.root)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result
			throw error
		}
		for (const entry of entries) {
			if (!entry.startsWith(FILE_PREFIX) || !entry.endsWith(FILE_SUFFIX)) continue
			const filePath = join(this.root, entry)
			let text: string
			try {
				// `lstat` without following links: a symlink or a directory is not a
				// checkpoint this store wrote, and a write to it would land elsewhere.
				const info = await lstat(filePath)
				if (!info.isFile()) {
					this.options.onError?.(`dsh-do: skipping checkpoint ${entry}: not a regular file`)
					continue
				}
				text = await readFile(filePath, 'utf8')
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
				this.options.onError?.(`dsh-do: could not read checkpoint ${entry}: ${String(error)}`)
				continue
			}
			let parsed: ReturnType<typeof parseCheckpoint>
			try {
				parsed = parseCheckpoint(text, entry)
			} catch (error) {
				this.options.onError?.(`dsh-do: skipping checkpoint ${entry}: ${String(error)}`)
				continue
			}
			if (!parsed.ok) {
				this.options.onError?.(`dsh-do: skipping checkpoint ${entry}: ${parsed.error}`)
				continue
			}
			// A session may accumulate records across loop replacements (terminal
			// files are kept as history); the newest record wins on restore.
			const existing = result.get(parsed.loop.sessionId)
			if (existing === undefined || parsed.loop.updatedAt > existing.updatedAt) {
				result.set(parsed.loop.sessionId, parsed.loop)
			}
		}
		return result
	}

	/** Atomically persist one loop, serialized per file. */
	write(loop: LoopState): Promise<void> {
		const target = this.path(loop.id)
		const previous = this.chains.get(target) ?? Promise.resolve()
		const next = previous
			.catch(() => undefined)
			.then(async () => {
				await mkdir(this.root, { recursive: true, mode: 0o700 })
				await writeAtomic(target, serializeCheckpoint(loop))
			})
		this.chains.set(target, next)
		next
			.catch(() => undefined)
			.finally(() => {
				if (this.chains.get(target) === next) this.chains.delete(target)
			})
		return next
	}
}
