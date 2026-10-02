/**
 * Settings bridge for the browser half: read the resolved settings the dsh-DO
 * page displays, and apply the path-scoped writes it stages.
 *
 * The page deliberately does NOT ride the client settings scope. Two reasons:
 * a retry policy lives at a NESTED path (`providers.<id>.retryPolicy`) while
 * the scope's `set` writes top-level fields only, and reconstructing the whole
 * `providers` map would materialize every resolved provider as a user override;
 * and the scope binder hard-requires the `connection` and `remote` client
 * services, which a plugin with a sidebar half has no other reason to depend
 * on. Serving both directions from this plugin's own route keeps the Host's
 * revision fencing and schema validation as the only write authority, and
 * mirrors the client-to-Host pattern the GitHub search and AI-install lanes
 * already use.
 *
 * @module dsh-do/settings-route
 */
import type { Context } from '@deepseek-ai/cordis';
/** Route the browser half reads and writes settings through. */
export declare const SETTINGS_PATH = "/dsh-do/settings";
/** One namespace as the page sees it. */
export interface SettingsSectionView {
    /** Namespace name. */
    readonly ns: string;
    /** Schema-resolved value the deployment would use. */
    readonly value: unknown;
    /** Raw user layer, so the page can mark which fields the user overrode. */
    readonly user?: unknown;
    /** Revision fencing the next write. */
    readonly revision: number;
}
/** One path-scoped operation accepted from the browser. */
export interface SettingsOperation {
    readonly op: 'set' | 'unset';
    readonly path: readonly string[];
    readonly value?: unknown;
}
/** A parsed write request. */
export interface SettingsWriteRequest {
    readonly ns: string;
    readonly ops: readonly SettingsOperation[];
    readonly expectedRevision?: number;
}
/**
 * Validate one browser-supplied request into a settings mutation.
 *
 * The route is reachable from the page, so nothing about the shape is assumed:
 * a namespace is a non-empty string, a path is an array of non-empty strings,
 * and a `set` carries a value. A revision is optional; when present it must be
 * a non-negative integer, and the Host refuses the write if the document has
 * moved past it.
 *
 * @param body - the parsed request body.
 * @returns the validated request, or the reason it was refused.
 */
export declare function parseSettingsWriteRequest(body: unknown): {
    ok: true;
    request: SettingsWriteRequest;
} | {
    ok: false;
    error: string;
};
/** The settings service face this route uses, narrowed to what it needs. */
interface SettingsFace {
    describe(options?: {
        redactSecrets?: boolean;
    }): ReadonlyArray<{
        ns: string;
        value: unknown;
        revision: number;
        user?: unknown;
    }>;
    mutate(ns: string, ops: readonly SettingsOperation[], expectedRevision?: number): Promise<{
        revision?: number;
    } | undefined>;
}
/**
 * Read the namespaces the page displays, redacted and narrowed to the fields
 * the page can act on. An unregistered namespace is simply absent, so a
 * deployment composing one adapter shows one policy instead of an inert form.
 *
 * @param settings - the settings service.
 * @returns the served sections.
 */
export declare function readSettingsView(settings: SettingsFace): SettingsSectionView[];
/**
 * Install `GET`/`POST /dsh-do/settings`.
 *
 * Lazy sibling injection: a deployment without a settings service or a web
 * server never registers the route, and the browser page reports that saving is
 * unavailable instead of the whole plugin failing.
 *
 * @param ctx - the plugin context.
 */
export declare function installSettingsRoute(ctx: Context): void;
export {};
