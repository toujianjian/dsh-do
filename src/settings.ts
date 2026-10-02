/**
 * dsh-DO's user-owned settings namespace.
 *
 * The plugin's composition entry stays the `base` layer, so a deployment that
 * never mounts a settings service runs exactly as composed; a `dsh-do:` section
 * in `$DSH_HOME/settings.yaml` overrides it live, and the loop tools, the round
 * driver and the browser settings card all read the same resolved value.
 *
 * @module dsh-do/settings
 */
import type { Context } from '@deepseek-ai/cordis'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

/** Namespace of dsh-DO's user-owned settings. */
export const DSH_DO_NS = settingsNamespace('dsh-do')

/**
 * The platform's marker for a live config reference.
 *
 * `schemastery`'s `.volatile()` marks a field as editable without remounting the
 * plugin, and the field's resolved value is then a frozen reference carrying a
 * `get()` instead of the value itself. The marker is a registered global symbol,
 * so it also matches references produced by another copy of the shared runtime.
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** Whether a resolved config node is a live reference rather than a plain value. */
function isVolatileValue(value: unknown): value is { get(): unknown } {
	return typeof value === 'object' && value !== null && VOLATILE_WRITE in value
}

/**
 * Whether a served settings section carries dsh-DO's own configuration.
 *
 * DSH 0.1.x files it under the registered namespace `dsh-do`, but 0.2.x keys
 * every section by its profile entry id instead — and that id belongs to the
 * deployment, not to this plugin, so the section is recognised by the fields it
 * carries rather than by the name it is filed under.
 *
 * @param ns - the namespace the section was served under.
 * @param value - the section's resolved value.
 * @returns whether this is dsh-DO's loop configuration.
 */
export function isDoSection(ns: string, value: unknown): boolean {
	if (ns === DSH_DO_NS) return true
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
	const record = value as Record<string, unknown>
	return 'defaultMaxRounds' in record && 'loopDetection' in record && 'autoContinue' in record
}

/**
 * Copy a resolved config, replacing every live reference with the value it holds
 * right now.
 *
 * Callers must read through this on every access and never cache the result:
 * that is what makes a committed settings change take effect without a restart,
 * because the reference is updated in place while the surrounding object stays.
 *
 * @param value - a resolved config node.
 * @returns the same shape with every live reference resolved.
 */
export function plainSettings<T>(value: T): T {
	if (isVolatileValue(value)) return plainSettings(value.get() as T)
	if (Array.isArray(value)) return value.map((child) => plainSettings(child)) as unknown as T
	if (typeof value === 'object' && value !== null) {
		return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainSettings(child)])) as T
	}
	return value
}

/**
 * Interruption policy for a model that repeats one tool call without making
 * progress. The detector stops the turn, optionally compacts the history, and
 * re-sends the request so the model continues from a smaller, loop-free state.
 */
export interface LoopDetectionSettings {
	/** Detect a repeating model loop and interrupt it. */
	enabled: boolean
	/** Consecutive identical tool calls that count as a loop. */
	repeatThreshold: number
	/** Compact the session before the interrupted request is re-sent. */
	compact: boolean
	/** Most interruptions allowed inside one turn, so recovery cannot loop itself. */
	maxInterventions: number
}

/**
 * What happens when a model response is cut off by its output-token limit.
 * Instead of stopping, dsh-DO queues a "continue where you stopped" turn.
 */
export interface AutoContinueSettings {
	/** Continue automatically after a `max-tokens` cut-off. */
	enabled: boolean
	/** Consecutive automatic continuations before giving up and stopping. */
	maxContinuations: number
	/** Only continue inside an armed dsh-DO loop; false continues any session. */
	onlyWhileLooping: boolean
}

/**
 * Switching to another model when the current one keeps failing. Runs after
 * the provider's own retry policy has given up, so a transient error is still
 * retried on the same model first.
 */
export interface ModelFallbackSettings {
	/** Switch models on a triggering failure. */
	enabled: boolean
	/** Candidates in order, each written as `provider/model`. */
	candidates: string[]
	/** Failure codes that trigger a switch. */
	triggerCodes: string[]
}

/** Failure codes that trigger a model switch unless the user overrides them. */
export const DEFAULT_FALLBACK_CODES = ['RATE_LIMIT', 'QUOTA', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE']

/** Resolved dsh-DO settings: schema defaults, then the composition entry, then the user section. */
export interface DoSettings {
	/** Default cap on automatic continuation rounds when `max_rounds` is omitted. */
	defaultMaxRounds: number
	/** Directory for durable loop checkpoints; empty derives from DSH_HOME. */
	checkpointDir: string
	/** Set false to keep loop state in memory only (no checkpoint files). */
	persist: boolean
	/** Model-loop detection and recovery. */
	loopDetection: LoopDetectionSettings
	/** Continuation after an output-limit cut-off. */
	autoContinue: AutoContinueSettings
	/** Automatic model switching on failure. */
	modelFallback: ModelFallbackSettings
}

/** A schema node that may or may not implement the live-edit marker. */
interface MaybeVolatile {
	volatile?: () => unknown
}

/**
 * Mark a config field as editable without remounting the plugin.
 *
 * `.volatile()` arrived in a later schemastery than some deployments resolve —
 * 3.18.1 has no such method at all — so calling it unconditionally would throw
 * while the plugin loads. Applying it only when present keeps the plugin loading
 * everywhere; where the marker is missing nothing is lost, because reads go
 * through {@link plainSettings} either way and 0.1.x does not filter on it.
 *
 * @param schema - the field or object schema.
 * @returns the same schema, marked volatile when the runtime supports it.
 */
function volatile<T>(schema: T): T {
	if (typeof (schema as MaybeVolatile).volatile !== 'function') return schema
	return (schema as unknown as { volatile(): T }).volatile()
}

/**
 * Settings schema. This is also the plugin's composition `Config`: the entry in
 * `cordis.patch.yml` is the `base` layer of the same namespace.
 *
 * The object itself is marked volatile — every field is read live through
 * {@link plainSettings}, so all of them may be edited without a remount. That
 * marking is also what makes the section appear at all: a settings service that
 * projects only volatile fields (DSH 0.2.x) hides an entry that declares none.
 */
export const Config = volatile(
	z.object({
		defaultMaxRounds: z.number().step(1).min(1).default(20),
		checkpointDir: z.string().default(''),
		persist: z.boolean().default(true),
		loopDetection: z.object({
			enabled: z.boolean().default(true),
			repeatThreshold: z.number().step(1).min(2).default(4),
			compact: z.boolean().default(true),
			maxInterventions: z.number().step(1).min(1).default(2),
		}),
		autoContinue: z.object({
			enabled: z.boolean().default(true),
			maxContinuations: z.number().step(1).min(1).default(3),
			onlyWhileLooping: z.boolean().default(true),
		}),
		modelFallback: z.object({
			enabled: z.boolean().default(false),
			candidates: z.array(z.string()).default([]),
			triggerCodes: z.array(z.string()).default([...DEFAULT_FALLBACK_CODES]),
		}),
	}),
)

/** Live reader for the resolved settings. */
export interface DoSettingsSource {
	/** Current resolved settings (composition entry while no settings service is mounted). */
	read(): DoSettings
}

/**
 * Register the `dsh-do` settings namespace and keep a live reader for it.
 *
 * `onApply` runs once for the first resolved value and again after every
 * committed change, including the detach that reverts to the composition entry.
 * Structurally equal resolutions are not re-applied, so a re-read of an
 * unchanged document cannot restart the store.
 *
 * @param ctx - the plugin context.
 * @param entry - the composition entry config, used as the namespace `base`.
 * @param onApply - applied to each new resolved value.
 * @returns the reader the rest of the plugin consults.
 */
export function installDoSettings(ctx: Context, entry: DoSettings, onApply: (next: DoSettings) => void): DoSettingsSource {
	// `entry` is the composition config exactly as the runtime handed it over, so
	// on DSH 0.2.x its volatile fields are live references. The reader unwraps on
	// every call rather than snapshotting once, which is what lets an edit land
	// without a restart.
	let source: () => unknown = () => entry
	const read = (): DoSettings => plainSettings(source()) as DoSettings
	let last: DoSettings = read()
	ctx.inject(['settings'], (sctx) => {
		const settings = sctx.settings as { register?: unknown } | undefined
		// DSH 0.2.x derives a section from the plugin entry's own `Config` and no
		// longer exposes namespace registration: the entry config *is* the section,
		// and the live references above already track it, so there is nothing to
		// wire. Registering anyway would call a method that no longer exists.
		if (typeof settings?.register !== 'function') return
		// `base` is the composition layer, not a live value, so it is flattened;
		// the live source stays the scope this registration returns.
		installSettingsSection(ctx, DSH_DO_NS, Config, plainSettings(entry), {
			setSource(current) {
				source = current
			},
			onChange() {
				const next = read()
				if (deepEqualJson(next, last)) return
				last = next
				onApply(next)
			},
		})
	})
	return { read }
}
