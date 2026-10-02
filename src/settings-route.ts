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
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readJsonBody } from './ai-install.js'

/** Route the browser half reads and writes settings through. */
export const SETTINGS_PATH = '/dsh-do/settings'

/** Namespaces the dsh-DO page reads. */
const READ_NAMESPACES = ['dsh-do', 'agent-default-model', 'llm-pi-ai', 'llm-deepseek'] as const

/** One namespace as the page sees it. */
export interface SettingsSectionView {
	/** Namespace name. */
	readonly ns: string
	/** Schema-resolved value the deployment would use. */
	readonly value: unknown
	/** Raw user layer, so the page can mark which fields the user overrode. */
	readonly user?: unknown
	/** Revision fencing the next write. */
	readonly revision: number
}

/** One path-scoped operation accepted from the browser. */
export interface SettingsOperation {
	readonly op: 'set' | 'unset'
	readonly path: readonly string[]
	readonly value?: unknown
}

/** A parsed write request. */
export interface SettingsWriteRequest {
	readonly ns: string
	readonly ops: readonly SettingsOperation[]
	readonly expectedRevision?: number
}

/** Write a JSON response with a stable cache policy. */
function json(res: ServerResponse, status: number, value: unknown): void {
	res.statusCode = status
	res.setHeader('Content-Type', 'application/json; charset=utf-8')
	res.setHeader('Cache-Control', 'no-store')
	res.end(JSON.stringify(value))
}

/** Whether a value is a JSON object literal, the only shape a root set accepts. */
function isPlainObjectValue(value: unknown): boolean {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
	const proto = Object.getPrototypeOf(value)
	return proto === Object.prototype || proto === null
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
export function parseSettingsWriteRequest(body: unknown): { ok: true; request: SettingsWriteRequest } | { ok: false; error: string } {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, error: 'a JSON object is required' }
	const record = body as Record<string, unknown>
	const ns = record.ns
	if (typeof ns !== 'string' || ns.trim() === '') return { ok: false, error: 'ns must be a non-empty string' }
	const rawOps = record.ops
	if (!Array.isArray(rawOps) || rawOps.length === 0) return { ok: false, error: 'ops must be a non-empty array' }
	const ops: SettingsOperation[] = []
	for (const raw of rawOps) {
		if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'each op must be an object' }
		const op = raw as Record<string, unknown>
		if (op.op !== 'set' && op.op !== 'unset') return { ok: false, error: 'op must be "set" or "unset"' }
		// An empty path is the namespace root, which is how the page saves the
		// whole dsh-do section in one revision-fenced write; `applyPathOp` treats
		// it as a section replacement and requires a plain object.
		if (!Array.isArray(op.path)) return { ok: false, error: 'path must be an array' }
		const path: string[] = []
		for (const segment of op.path) {
			if (typeof segment !== 'string' || segment === '') return { ok: false, error: 'every path segment must be a non-empty string' }
			path.push(segment)
		}
		if (op.op === 'set' && !('value' in op)) return { ok: false, error: 'a set op requires a value' }
		// `applyPathOp` throws a TypeError for a root set whose value is not a
		// plain object, so a malformed request would otherwise surface as a
		// service-internal failure instead of a 400 about the request itself.
		if (op.op === 'set' && path.length === 0 && !isPlainObjectValue(op.value)) {
			return { ok: false, error: 'a set op at the namespace root requires a plain object value' }
		}
		ops.push(op.op === 'set' ? { op: 'set', path, value: op.value } : { op: 'unset', path })
	}
	const expectedRevision = record.expectedRevision
	if (expectedRevision !== undefined && (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
		return { ok: false, error: 'expectedRevision must be a non-negative integer' }
	}
	return { ok: true, request: { ns, ops, ...(expectedRevision === undefined ? {} : { expectedRevision }) } }
}

/** The settings service face this route uses, narrowed to what it needs. */
interface SettingsFace {
	describe(options?: { redactSecrets?: boolean }): ReadonlyArray<{ ns: string; value: unknown; revision: number; user?: unknown }>
	mutate(ns: string, ops: readonly SettingsOperation[], expectedRevision?: number): Promise<{ revision?: number } | undefined>
}

/**
 * Read the namespaces the page displays, redacted and narrowed to the fields
 * the page can act on. An unregistered namespace is simply absent, so a
 * deployment composing one adapter shows one policy instead of an inert form.
 *
 * @param settings - the settings service.
 * @returns the served sections.
 */
export function readSettingsView(settings: SettingsFace): SettingsSectionView[] {
	const wanted = new Set<string>(READ_NAMESPACES)
	const views: SettingsSectionView[] = []
	for (const descriptor of settings.describe({ redactSecrets: true })) {
		if (!wanted.has(descriptor.ns)) continue
		views.push({
			ns: descriptor.ns,
			value: descriptor.value,
			...(descriptor.user === undefined ? {} : { user: descriptor.user }),
			revision: descriptor.revision,
		})
	}
	return views
}

/**
 * Install `GET`/`POST /dsh-do/settings`.
 *
 * Lazy sibling injection: a deployment without a settings service or a web
 * server never registers the route, and the browser page reports that saving is
 * unavailable instead of the whole plugin failing.
 *
 * @param ctx - the plugin context.
 */
export function installSettingsRoute(ctx: Context): void {
	ctx.inject(['webServer', 'settings'], (child) => {
		const server = child.get('webServer')
		const settings = child.get('settings') as SettingsFace
		child.effect(
			() => server.register({
				kind: 'exact',
				path: SETTINGS_PATH,
				handler: async (req: IncomingMessage, res: ServerResponse) => {
					// Settings are a privileged local surface: require same-origin
					// requests, so no cross-origin page can read or rewrite the document.
					const origin = req.headers.origin
					let foreignOrigin = false
					if (origin !== undefined) {
						try {
							const url = new URL(origin)
							foreignOrigin = !['http:', 'https:'].includes(url.protocol) || url.host !== req.headers.host
						} catch { foreignOrigin = true }
					}
					if (foreignOrigin || req.headers['sec-fetch-site'] === 'cross-site') {
						json(res, 403, { ok: false, error: 'cross-site settings request denied' })
						return
					}
					if (req.method === 'GET') {
						try {
							json(res, 200, { ok: true, sections: readSettingsView(settings) })
						} catch (error) {
							json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
						}
						return
					}
					if (req.method !== 'POST') {
						res.setHeader('Allow', 'GET, POST')
						json(res, 405, { ok: false, error: 'method not allowed (use GET or POST)' })
						return
					}
					if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
						json(res, 415, { ok: false, error: 'application/json is required' })
						return
					}
					let body: unknown
					try {
						body = await readJsonBody(req)
					} catch (error) {
						json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
						return
					}
					const parsed = parseSettingsWriteRequest(body)
					if (!parsed.ok) {
						json(res, 400, { ok: false, error: parsed.error })
						return
					}
					try {
						const { ns, ops, expectedRevision } = parsed.request
						const result = await settings.mutate(ns, ops, expectedRevision)
						// Read back through the same projection the GET serves, so the
						// page shows what the Host accepted rather than what it staged.
						json(res, 200, {
							ok: true,
							sections: readSettingsView(settings),
							...(typeof result?.revision === 'number' ? { revision: result.revision } : {}),
						})
					} catch (error) {
						// The Host is the authority on whether a value is acceptable. Its
						// conflict error carries the documented `SETTINGS_CONFLICT`
						// machine code, and only that code means "your copy is stale";
						// reporting a malformed request or a deployment-side refusal as
						// 409 would tell the page to reload for the wrong reason. A
						// TypeError is the service rejecting the op shape or a
						// non-JSON-compatible value, which is a request error.
						const code = (error as { code?: unknown }).code
						const status = code === 'SETTINGS_CONFLICT' ? 409 : error instanceof TypeError ? 400 : 500
						json(res, status, {
							ok: false,
							error: error instanceof Error ? error.message : String(error),
							...(typeof code === 'string' ? { code } : {}),
						})
					}
				},
			}, 'dsh-do.settings-route()'),
		)
	})
}
