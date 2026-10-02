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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** Namespace of dsh-DO's user-owned settings. */
export declare const DSH_DO_NS: import("@deepseek-ai/dsh-settings").SettingsNamespace;
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
export declare function isDoSection(ns: string, value: unknown): boolean;
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
export declare function plainSettings<T>(value: T): T;
/**
 * Interruption policy for a model that repeats one tool call without making
 * progress. The detector stops the turn, optionally compacts the history, and
 * re-sends the request so the model continues from a smaller, loop-free state.
 */
export interface LoopDetectionSettings {
    /** Detect a repeating model loop and interrupt it. */
    enabled: boolean;
    /** Consecutive identical tool calls that count as a loop. */
    repeatThreshold: number;
    /** Compact the session before the interrupted request is re-sent. */
    compact: boolean;
    /** Most interruptions allowed inside one turn, so recovery cannot loop itself. */
    maxInterventions: number;
}
/**
 * What happens when a model response is cut off by its output-token limit.
 * Instead of stopping, dsh-DO queues a "continue where you stopped" turn.
 */
export interface AutoContinueSettings {
    /** Continue automatically after a `max-tokens` cut-off. */
    enabled: boolean;
    /** Consecutive automatic continuations before giving up and stopping. */
    maxContinuations: number;
    /** Only continue inside an armed dsh-DO loop; false continues any session. */
    onlyWhileLooping: boolean;
}
/**
 * Switching to another model when the current one keeps failing. Runs after
 * the provider's own retry policy has given up, so a transient error is still
 * retried on the same model first.
 */
export interface ModelFallbackSettings {
    /** Switch models on a triggering failure. */
    enabled: boolean;
    /** Candidates in order, each written as `provider/model`. */
    candidates: string[];
    /** Failure codes that trigger a switch. */
    triggerCodes: string[];
}
/** Failure codes that trigger a model switch unless the user overrides them. */
export declare const DEFAULT_FALLBACK_CODES: string[];
/** Resolved dsh-DO settings: schema defaults, then the composition entry, then the user section. */
export interface DoSettings {
    /** Default cap on automatic continuation rounds when `max_rounds` is omitted. */
    defaultMaxRounds: number;
    /** Directory for durable loop checkpoints; empty derives from DSH_HOME. */
    checkpointDir: string;
    /** Set false to keep loop state in memory only (no checkpoint files). */
    persist: boolean;
    /** Model-loop detection and recovery. */
    loopDetection: LoopDetectionSettings;
    /** Continuation after an output-limit cut-off. */
    autoContinue: AutoContinueSettings;
    /** Automatic model switching on failure. */
    modelFallback: ModelFallbackSettings;
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
export declare const Config: z<Schemastery.ObjectS<{
    defaultMaxRounds: z<number, number>;
    checkpointDir: z<string, string>;
    persist: z<boolean, boolean>;
    loopDetection: z<Schemastery.ObjectS<{
        enabled: z<boolean, boolean>;
        repeatThreshold: z<number, number>;
        compact: z<boolean, boolean>;
        maxInterventions: z<number, number>;
    }>, Schemastery.ObjectT<{
        enabled: z<boolean, boolean>;
        repeatThreshold: z<number, number>;
        compact: z<boolean, boolean>;
        maxInterventions: z<number, number>;
    }>>;
    autoContinue: z<Schemastery.ObjectS<{
        enabled: z<boolean, boolean>;
        maxContinuations: z<number, number>;
        onlyWhileLooping: z<boolean, boolean>;
    }>, Schemastery.ObjectT<{
        enabled: z<boolean, boolean>;
        maxContinuations: z<number, number>;
        onlyWhileLooping: z<boolean, boolean>;
    }>>;
    modelFallback: z<Schemastery.ObjectS<{
        enabled: z<boolean, boolean>;
        candidates: z<string[], string[]>;
        triggerCodes: z<string[], string[]>;
    }>, Schemastery.ObjectT<{
        enabled: z<boolean, boolean>;
        candidates: z<string[], string[]>;
        triggerCodes: z<string[], string[]>;
    }>>;
}>, Schemastery.ObjectT<{
    defaultMaxRounds: z<number, number>;
    checkpointDir: z<string, string>;
    persist: z<boolean, boolean>;
    loopDetection: z<Schemastery.ObjectS<{
        enabled: z<boolean, boolean>;
        repeatThreshold: z<number, number>;
        compact: z<boolean, boolean>;
        maxInterventions: z<number, number>;
    }>, Schemastery.ObjectT<{
        enabled: z<boolean, boolean>;
        repeatThreshold: z<number, number>;
        compact: z<boolean, boolean>;
        maxInterventions: z<number, number>;
    }>>;
    autoContinue: z<Schemastery.ObjectS<{
        enabled: z<boolean, boolean>;
        maxContinuations: z<number, number>;
        onlyWhileLooping: z<boolean, boolean>;
    }>, Schemastery.ObjectT<{
        enabled: z<boolean, boolean>;
        maxContinuations: z<number, number>;
        onlyWhileLooping: z<boolean, boolean>;
    }>>;
    modelFallback: z<Schemastery.ObjectS<{
        enabled: z<boolean, boolean>;
        candidates: z<string[], string[]>;
        triggerCodes: z<string[], string[]>;
    }>, Schemastery.ObjectT<{
        enabled: z<boolean, boolean>;
        candidates: z<string[], string[]>;
        triggerCodes: z<string[], string[]>;
    }>>;
}>>;
/** Live reader for the resolved settings. */
export interface DoSettingsSource {
    /** Current resolved settings (composition entry while no settings service is mounted). */
    read(): DoSettings;
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
export declare function installDoSettings(ctx: Context, entry: DoSettings, onApply: (next: DoSettings) => void): DoSettingsSource;
