/**
 * dshplugin.app registry crawler: fetches the DSH Plugin Registry homepage,
 * extracts its embedded RSC plugin entries, and serves them as JSON through a
 * host web-server route (the browser half fetches the same-origin route, so
 * no CORS is involved).
 *
 * @module dsh-do/registry
 */
import type { Context } from '@deepseek-ai/cordis';
/** The registry site this module crawls. */
export declare const REGISTRY_URL = "https://dshplugin.app/";
/** Time budget for one registry fetch (the site is occasionally slow). */
export declare const FETCH_TIMEOUT_MS = 30000;
/** One parsed plugin entry from the registry homepage. */
export interface DshPluginRegistryEntry {
    readonly slug: string;
    readonly name: string;
    readonly repository?: string;
    readonly repositoryUrl?: string;
    readonly description?: string;
    readonly categories: readonly string[];
    readonly installCommand?: string;
    readonly status?: string;
    readonly profile?: string;
    readonly license?: string;
    readonly packageName: string;
    readonly version?: string;
    readonly indexedAt?: string;
}
/**
 * Extract plugin entries from the registry homepage HTML. Duplicate
 * `packageName`s keep their first occurrence.
 * @param html - the raw homepage document.
 * @returns the parsed entries, in page order.
 */
export declare function parseDshPluginRegistry(html: string): DshPluginRegistryEntry[];
/**
 * Fetch and parse the live registry.
 * @param signal - optional cancellation; defaults to an internal timeout.
 * @returns the parsed entries.
 * @throws when the site is unreachable or returns a non-2xx status.
 */
export declare function fetchDshPluginRegistry(signal?: AbortSignal): Promise<DshPluginRegistryEntry[]>;
/**
 * Install the `GET /dsh-do/registry` proxy route on the harness web server.
 * The web server is a sibling provider, so the route is mounted lazily via
 * `ctx.inject` — never reached for in `apply` (a headless composition without
 * a web server simply never mounts the route).
 * @param ctx - the plugin context.
 */
export declare function installRegistryRoute(ctx: Context): void;
