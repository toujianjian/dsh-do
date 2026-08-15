/**
 * dshplugin.app registry crawler: fetches the DSH Plugin Registry homepage,
 * extracts its embedded RSC plugin entries, and serves them as JSON through a
 * host web-server route (the browser half fetches the same-origin route, so
 * no CORS is involved).
 *
 * @module dsh-do/registry
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** The registry site this module crawls. */
export const REGISTRY_URL = 'https://dshplugin.app/'

/** Time budget for one registry fetch (the site is occasionally slow). */
export const FETCH_TIMEOUT_MS = 30_000

/** One parsed plugin entry from the registry homepage. */
export interface DshPluginRegistryEntry {
  readonly slug: string
  readonly name: string
  readonly repository?: string
  readonly repositoryUrl?: string
  readonly description?: string
  readonly categories: readonly string[]
  readonly installCommand?: string
  readonly status?: string
  readonly profile?: string
  readonly license?: string
  readonly packageName: string
  readonly version?: string
  readonly indexedAt?: string
}

/**
 * The homepage embeds the registry as RSC records shaped like
 * `$R[134]={slug:"dsh-a2a",name:"dsh-a2a",repository:"dpskh/dsh-a2a",...}`.
 * The field order is stable across entries; the matcher tolerates `license`
 * being either `void 0` or a quoted string, and every quoted field may carry
 * JSON escapes. Entries that do not match are skipped (registry evolves).
 */
const ENTRY_RE =
  /\$R\[\d+\]=\{slug:"((?:[^"\\]|\\.)*)",name:"((?:[^"\\]|\\.)*)",repository:"((?:[^"\\]|\\.)*)",repositoryUrl:"((?:[^"\\]|\\.)*)",description:"((?:[^"\\]|\\.)*)",categories:\$R\[\d+\]=\[(.*?)\],installCommand:"((?:[^"\\]|\\.)*)",status:"((?:[^"\\]|\\.)*)",profile:"((?:[^"\\]|\\.)*)",license:(?:void 0|"((?:[^"\\]|\\.)*)"),packageName:"((?:[^"\\]|\\.)*)",version:"((?:[^"\\]|\\.)*)",indexedAt:"((?:[^"\\]|\\.)*)"\}/g

/** Reverse a JSON-escaped quoted field, with a forgiving fallback. */
function unescapeField(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string
  } catch {
    return raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
}

/** Parse the captured categories array body (no brackets) into a string list, forgivingly. */
function parseCategories(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(`[${raw}]`)
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  } catch {
    /* fall through */
  }
  return []
}

/**
 * Extract plugin entries from the registry homepage HTML. Duplicate
 * `packageName`s keep their first occurrence.
 * @param html - the raw homepage document.
 * @returns the parsed entries, in page order.
 */
export function parseDshPluginRegistry(html: string): DshPluginRegistryEntry[] {
  const entries: DshPluginRegistryEntry[] = []
  const seen = new Set<string>()
  for (const match of html.matchAll(ENTRY_RE)) {
    // Optional branches (`license: void 0`) leave their capture group
    // unparticipating, i.e. `undefined` — normalize to '' first.
    const at = (index: number): string => match[index] ?? ''
    const packageName = unescapeField(at(11))
    if (packageName.length === 0 || seen.has(packageName)) continue
    seen.add(packageName)
    entries.push({
      slug: unescapeField(at(1)),
      name: unescapeField(at(2)),
      ...(at(3).length > 0 ? { repository: unescapeField(at(3)) } : {}),
      ...(at(4).length > 0 ? { repositoryUrl: unescapeField(at(4)) } : {}),
      ...(at(5).length > 0 ? { description: unescapeField(at(5)) } : {}),
      categories: parseCategories(at(6)),
      ...(at(7).length > 0 ? { installCommand: unescapeField(at(7)) } : {}),
      ...(at(8).length > 0 ? { status: unescapeField(at(8)) } : {}),
      ...(at(9).length > 0 ? { profile: unescapeField(at(9)) } : {}),
      ...(at(10).length > 0 ? { license: unescapeField(at(10)) } : {}),
      packageName,
      ...(at(12).length > 0 ? { version: unescapeField(at(12)) } : {}),
      ...(at(13).length > 0 ? { indexedAt: unescapeField(at(13)) } : {}),
    })
  }
  return entries
}

/**
 * Fetch and parse the live registry.
 * @param signal - optional cancellation; defaults to an internal timeout.
 * @returns the parsed entries.
 * @throws when the site is unreachable or returns a non-2xx status.
 */
export async function fetchDshPluginRegistry(signal?: AbortSignal): Promise<DshPluginRegistryEntry[]> {
  const response = await fetch(REGISTRY_URL, {
    headers: { 'user-agent': 'dsh-do/0.1 (+https://dshplugin.app/)' },
    signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`dshplugin.app responded ${response.status}`)
  const html = await response.text()
  return parseDshPluginRegistry(html)
}

/**
 * Install the `GET /dsh-do/registry` proxy route on the harness web server.
 * The web server is a sibling provider, so the route is mounted lazily via
 * `ctx.inject` — never reached for in `apply` (a headless composition without
 * a web server simply never mounts the route).
 * @param ctx - the plugin context.
 */
export function installRegistryRoute(ctx: Context): void {
  ctx.inject(['webServer'], (child) => {
    const server = child.get('webServer')
    child.effect(
      () => server.register({
        kind: 'exact',
        path: '/dsh-do/registry',
        handler: async (_req: IncomingMessage, res: ServerResponse) => {
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.setHeader('Cache-Control', 'no-cache')
          try {
            const plugins = await fetchDshPluginRegistry()
            res.end(JSON.stringify({
              ok: true,
              source: REGISTRY_URL,
              fetchedAt: Date.now(),
              count: plugins.length,
              plugins,
            }))
          } catch (error) {
            res.statusCode = 502
            res.end(JSON.stringify({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }))
          }
        },
      }, 'dsh-do.registry-route()'),
    )
  })
}
