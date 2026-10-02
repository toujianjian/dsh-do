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

/**
 * Settings schema. This is also the plugin's composition `Config`: the entry in
 * `cordis.patch.yml` is the `base` layer of the same namespace.
 */
export const Config = z.object({
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
})

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
	let source: () => DoSettings = () => entry
	let last: DoSettings = entry
	installSettingsSection(ctx, DSH_DO_NS, Config, entry, {
		setSource(current) {
			source = current
		},
		onChange() {
			const next = source()
			if (deepEqualJson(next, last)) return
			last = next
			onApply(next)
		},
	})
	return { read: () => source() }
}
