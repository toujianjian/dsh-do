import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';
/** Namespace of dsh-DO's user-owned settings. */
export const DSH_DO_NS = settingsNamespace('dsh-do');
/**
 * The platform's marker for a live config reference.
 *
 * `schemastery`'s `.volatile()` marks a field as editable without remounting the
 * plugin, and the field's resolved value is then a frozen reference carrying a
 * `get()` instead of the value itself. The marker is a registered global symbol,
 * so it also matches references produced by another copy of the shared runtime.
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');
/** Whether a resolved config node is a live reference rather than a plain value. */
function isVolatileValue(value) {
    return typeof value === 'object' && value !== null && VOLATILE_WRITE in value;
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
export function isDoSection(ns, value) {
    if (ns === DSH_DO_NS)
        return true;
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    const record = value;
    return 'defaultMaxRounds' in record && 'loopDetection' in record && 'autoContinue' in record;
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
export function plainSettings(value) {
    if (isVolatileValue(value))
        return plainSettings(value.get());
    if (Array.isArray(value))
        return value.map((child) => plainSettings(child));
    if (typeof value === 'object' && value !== null) {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainSettings(child)]));
    }
    return value;
}
/** Failure codes that trigger a model switch unless the user overrides them. */
export const DEFAULT_FALLBACK_CODES = ['RATE_LIMIT', 'QUOTA', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'];
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
function volatile(schema) {
    if (typeof schema.volatile !== 'function')
        return schema;
    return schema.volatile();
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
export const Config = volatile(z.object({
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
}));
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
    // `entry` is the composition config exactly as the runtime handed it over, so
    // on DSH 0.2.x its volatile fields are live references. The reader unwraps on
    // every call rather than snapshotting once, which is what lets an edit land
    // without a restart.
    let source = () => entry;
    const read = () => plainSettings(source());
    let last = read();
    ctx.inject(['settings'], (sctx) => {
        const settings = sctx.settings;
        // DSH 0.2.x derives a section from the plugin entry's own `Config` and no
        // longer exposes namespace registration: the entry config *is* the section,
        // and the live references above already track it, so there is nothing to
        // wire. Registering anyway would call a method that no longer exists.
        if (typeof settings?.register !== 'function')
            return;
        // `base` is the composition layer, not a live value, so it is flattened;
        // the live source stays the scope this registration returns.
        installSettingsSection(ctx, DSH_DO_NS, Config, plainSettings(entry), {
            setSource(current) {
                source = current;
            },
            onChange() {
                const next = read();
                if (deepEqualJson(next, last))
                    return;
                last = next;
                onApply(next);
            },
        });
    });
    return { read };
}
//# sourceMappingURL=settings.js.map