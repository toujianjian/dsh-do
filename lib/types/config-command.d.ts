/**
 * `/do-config`: view and change every dsh-DO setting from a command line.
 *
 * The TUI has no settings page, so a browser-only form left TUI users with
 * nothing but hand-editing YAML. This command closes that gap in both command
 * registries the plugin already reaches: the harness `commands` service (web
 * and headless) and the TUI's own `tui.commands` registry. Both write through
 * the `settings` service, so a change lands in `$DSH_HOME/settings.yaml` under
 * the `dsh-do:` section and is picked up live, exactly as a browser save.
 *
 * Syntax (paths are dotted, values are loose: `true`, `3`, `a,b` all work):
 *
 *     /do-config                      list every setting with its current value
 *     /do-config <path>               show one setting
 *     /do-config <path> <value>       set it
 *     /do-config reset <path>         drop the override (back to the default)
 *     /do-config file                 show where the settings file lives
 *
 * @module dsh-do/config-command
 */
import type { Context } from '@deepseek-ai/cordis';
/** Command name; distinct from the TUI builtin `/config` so prefixes stay unambiguous. */
export declare const CONFIG_COMMAND_NAME = "do-config";
/** One editable leaf: its dotted path, its value type, and what it does. */
export interface ConfigField {
    readonly path: string;
    readonly type: 'boolean' | 'integer' | 'string' | 'list';
    readonly min?: number;
    readonly help: string;
}
/** Every user-editable dsh-DO setting, in display order. */
export declare const CONFIG_FIELDS: readonly ConfigField[];
/** One display group: a heading, a one-line hint, and the fields it holds. */
export interface ConfigGroup {
    readonly title: string;
    readonly note: string;
    readonly paths: readonly string[];
}
/**
 * Display grouping for the `/do-config` listing — the flat 13-line list was
 * unreadable, so related knobs are shown together under a heading.
 *
 * Every path here must exist in {@link CONFIG_FIELDS}, and every field must
 * appear exactly once; a test asserts the two cover each other.
 */
export declare const CONFIG_GROUPS: readonly ConfigGroup[];
/** The slice of the settings service this command uses. */
export interface SettingsAccess {
    get(ns: string): unknown;
    mutate(ns: string, ops: readonly unknown[]): Promise<unknown>;
}
/**
 * Present either generation of the settings service as one access face.
 *
 * DSH 0.1.x exposes `get(ns)` over namespaces the plugin registered itself. 0.2.x
 * dropped both the registration and `get`, deriving a section from the plugin
 * entry's own Config and keying it by profile entry id; `describe` and `mutate`
 * are what remain. The namespace is resolved per call because a live edit can
 * change which entry carries the section.
 *
 * @param service - the mounted settings service, if any.
 * @returns the access face, or undefined when neither shape is available.
 */
export declare function adaptSettingsAccess(service: unknown): SettingsAccess | undefined;
/** Parsed command. */
export type ConfigCommand = {
    readonly kind: 'list';
} | {
    readonly kind: 'file';
} | {
    readonly kind: 'show';
    readonly path: string;
} | {
    readonly kind: 'set';
    readonly path: string;
    readonly raw: string;
} | {
    readonly kind: 'reset';
    readonly path: string;
};
/** Parse the text after `/do-config`. */
export declare function parseConfigCommand(text: string): ConfigCommand;
/** Find a field by exact path, or by a unique case-insensitive suffix (`candidates`). */
export declare function findField(path: string): ConfigField | undefined;
/**
 * Coerce a loosely typed value. Formatting is deliberately forgiving: booleans
 * accept on/off/yes/no/开/关, lists accept commas, spaces, or a JSON array.
 */
export declare function coerceValue(field: ConfigField, raw: string): {
    ok: true;
    value: unknown;
} | {
    ok: false;
    error: string;
};
/** Read a dotted path out of a plain object. */
export declare function readPath(value: unknown, path: string): unknown;
/** Display form of a value. */
export declare function formatSetting(value: unknown): string;
/** Rendering options for the listing. */
export interface ListingOptions {
    /**
     * Emit ANSI attributes. The TUI writes command output straight into its
     * scrollback (which is colour-aware), but the harness `commands` service
     * renders plain text — escapes there would surface as literal `[1m`.
     */
    readonly color?: boolean;
}
/**
 * Terminal cell width of a string, counting CJK as two cells.
 *
 * ANSI sequences are dropped first so padding stays correct when the same text
 * is measured painted or unpainted.
 *
 * @param text - the text to measure.
 * @returns its width in terminal cells.
 */
export declare function displayWidth(text: string): number;
/**
 * Every line `/do-config` prints for the full listing: a command box, then one
 * aligned block per group.
 *
 * @param resolved - the resolved dsh-DO config.
 * @param options - rendering options (see {@link ListingOptions}).
 * @returns the listing lines.
 */
export declare function renderConfigListing(resolved: unknown, options?: ListingOptions): string[];
/** Outcome of one command. */
export interface ConfigOutcome {
    readonly ok: boolean;
    readonly lines: readonly string[];
}
/**
 * Run one `/do-config` command against the settings service.
 *
 * @param settings - the settings service, or undefined when none is mounted.
 * @param text - the text after the command name.
 * @param fileHint - where the settings document lives, for `file`.
 * @param options - rendering options (see {@link ListingOptions}).
 */
export declare function executeConfigCommand(settings: SettingsAccess | undefined, text: string, fileHint: string, options?: ListingOptions): Promise<ConfigOutcome>;
/**
 * Register `/do-config` in every command registry the composition offers.
 *
 * @param ctx - the plugin context.
 */
export declare function installConfigCommand(ctx: Context): void;
