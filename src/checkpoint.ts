/**
 * File-per-loop checkpoint store. Each loop owns one `<root>/loop-<id>.json`;
 * every write is an atomic whole-file publish (same-directory temp + fsync +
 * rename), and writes to one file are serialized through an in-flight chain so
 * concurrent transitions cannot interleave whole-file replacements.
 *
 * @module dsh-do/checkpoint
 */
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { LoopPhase, LoopState } from './loop.js'

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
	if (version !== 1) return { ok: false, error: `file ${fileName} has unsupported version ${String(version)}` }
	if (typeof loop !== 'object' || loop === null) return { ok: false, error: `file ${fileName} has no loop record` }
	const state = loop as Record<string, unknown>
	if (typeof state.id !== 'string' || typeof state.sessionId !== 'string' || typeof state.objective !== 'string') {
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
		if (typeof reason.code !== 'string' || typeof reason.message !== 'string') {
			return { ok: false, error: `file ${fileName} has an invalid blockedReason` }
		}
	}
	for (const key of ['startedAt', 'updatedAt'] as const) {
		if (typeof state[key] !== 'number') return { ok: false, error: `file ${fileName} has an invalid ${key}` }
	}
	return {
		ok: true,
		loop: {
			id: state.id as LoopState['id'],
			sessionId: state.sessionId,
			objective: state.objective,
			maxRounds: state.maxRounds,
			phase: state.phase as LoopPhase,
			armed: state.armed,
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
		return join(this.root, `${FILE_PREFIX}${loopId}${FILE_SUFFIX}`)
	}

	/** Load every checkpoint file; returns loops keyed by session id. */
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
				text = await readFile(filePath, 'utf8')
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
				this.options.onError?.(`dsh-do: could not read checkpoint ${entry}: ${String(error)}`)
				continue
			}
			const parsed = parseCheckpoint(text, entry)
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
