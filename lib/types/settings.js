import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';
/** Namespace of dsh-DO's user-owned settings. */
export const DSH_DO_NS = settingsNamespace('dsh-do');
/** Failure codes that trigger a model switch unless the user overrides them. */
export const DEFAULT_FALLBACK_CODES = ['RATE_LIMIT', 'QUOTA', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'];
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
});
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
export function installDoSettings(ctx, entry, onApply) {
    let source = () => entry;
    let last = entry;
    installSettingsSection(ctx, DSH_DO_NS, Config, entry, {
        setSource(current) {
            source = current;
        },
        onChange() {
            const next = source();
            if (deepEqualJson(next, last))
                return;
            last = next;
            onApply(next);
        },
    });
    return { read: () => source() };
}
//# sourceMappingURL=settings.js.map