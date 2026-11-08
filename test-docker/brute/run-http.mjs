/**
 * Tier 1c: HTTP surfaces.
 *
 * Two layers are exercised: `readJsonBody` (the only body parser both routes
 * share) with hostile streams, and the real settings-route handler mounted on a
 * fake Context -?status-code taxonomy, origin guard, and response shape.
 */
import { EventEmitter } from 'node:events'
import { readJsonBody } from './lib/types/ai-install.js'
import { installSettingsRoute, parseSettingsWriteRequest } from './lib/types/settings-route.js'

const failures = []
const notes = []
const fail = (area, label, error) => failures.push({ area, label, error: error instanceof Error ? error.message : String(error) })

function reqFrom(chunks, { throwAfter, method = 'POST', headers = {} } = {}) {
	return {
		method,
		headers,
		async *[Symbol.asyncIterator]() {
			let i = 0
			for (const chunk of chunks) {
				yield chunk
				i++
				if (throwAfter !== undefined && i >= throwAfter) throw new Error('aborted by peer')
			}
		},
	}
}

async function expect(label, fn, check) {
	try {
		const value = await fn()
		check?.(value, undefined)
	} catch (error) {
		check?.(undefined, error)
	}
}

// ---------------------------------------------------------------- readJsonBody
await expect('empty body', () => readJsonBody(reqFrom([])), (value, error) => {
	if (error !== undefined) fail('body.empty', 'empty', error)
	else if (value !== undefined) fail('body.empty', 'empty', `expected undefined, got ${JSON.stringify(value)}`)
})
await expect('64KiB boundary', () => readJsonBody(reqFrom([Buffer.from(' '.repeat(65_534) + '{}')])), (value, error) => {
	if (error !== undefined) fail('body.boundary', 'exactly 64KiB', error)
	else if (value === null || typeof value !== 'object') fail('body.boundary', 'value', 'expected the parsed object')
})
await expect('64KiB+1', () => readJsonBody(reqFrom([Buffer.alloc(65_537)])), (_value, error) => {
	if (error === undefined || !/too large/.test(error.message)) fail('body.oversize', 'limit', `expected a size rejection, got ${error?.message ?? 'no error'}`)
})
for (const [label, chunks] of [
	['string chunks', ['{"a":', '1}']],
	['mixed chunks', ['{"a":', Buffer.from('1}')]],
	['invalid json', ['{']],
	['deep json', ['['.repeat(2000) + ']'.repeat(2000)]],
	['huge json value', ['{"x":"' + 'a'.repeat(65_000) + '"}']],
	['nul bytes', [Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x00, 0x7d])]],
	['lone surrogate utf8', [Buffer.from([0x22, 0xed, 0xa0, 0x80, 0x22])]],
]) {
	await expect(label, () => readJsonBody(reqFrom(chunks)), (_value, error) => {
		notes.push(`body ${label}: ${error === undefined ? 'parsed' : `rejected (${error.name}: ${error.message})`}`)
	})
}
await expect('aborted stream', () => readJsonBody(reqFrom([Buffer.from('{"a":')], { throwAfter: 1 })), (_value, error) => {
	if (error === undefined) fail('body.abort', 'aborted', 'aborted stream resolved instead of rejecting')
	else notes.push(`body aborted: ${error.message}`)
})
// A body announced larger than the parser reads must still be rejected.
await expect('chunked overflow', () => readJsonBody(reqFrom([Buffer.alloc(40_000), Buffer.alloc(40_000)])), (_value, error) => {
	if (error === undefined) fail('body.chunked', 'overflow', 'two 40KB chunks accepted past the 64KB budget')
})

// ---------------------------------------------------------------- settings route
const routes = []
const fakeCtx = {
	inject(_deps, callback) {
		const child = {
			get: (name) =>
				name === 'webServer'
					? { register: (route) => (routes.push(route), () => undefined) }
					: fakeSettings,
			effect: (fn) => {
				const disposer = fn()
				return disposer
			},
		}
		callback(child)
	},
}
let mutateMode = 'ok'
const fakeSettings = {
	describe: () => [
		{ ns: 'dsh-do', value: { enabled: true }, revision: 3 },
		{ ns: 'llm-deepseek', value: { secret: 'x' }, revision: 1, user: {} },
		{ ns: 'secret-internal', value: { a: 1 }, revision: 0 },
	],
	mutate: async (ns, ops, revision) => {
		if (mutateMode === 'conflict') throw Object.assign(new Error('stale'), { code: 'SETTINGS_CONFLICT' })
		if (mutateMode === 'type') throw new TypeError('bad op shape')
		if (mutateMode === 'boom') throw new Error('provider exploded')
		return { revision: (revision ?? 0) + 1 }
	},
}
installSettingsRoute(fakeCtx)
if (routes.length !== 1) fail('route.mount', 'register', `expected 1 route, got ${routes.length}`)
const handler = routes[0]?.handler

function res() {
	const captured = { statusCode: 0, headers: {}, body: undefined, ended: false }
	const response = {
		get statusCode() {
			return captured.statusCode
		},
		set statusCode(value) {
			captured.statusCode = value
		},
		setHeader: (name, value) => (captured.headers[name.toLowerCase()] = value),
		end: (body) => {
			captured.body = body
			captured.ended = true
		},
	}
	return { captured, response }
}

async function call({ method = 'POST', headers = {}, chunks = ['{}'] }) {
	const { captured, response } = res()
	const req = reqFrom(chunks, { method, headers })
	await handler(req, response)
	let parsed
	try {
		parsed = JSON.parse(captured.body)
	} catch {
		fail('route.response', 'json', `body is not JSON: ${String(response.captured.body).slice(0, 120)}`)
	}
	return { status: captured.statusCode, body: parsed, headers: captured.headers }
}

const cases = [
	['GET same origin', { method: 'GET', headers: { host: 'h', origin: 'http://h' }, chunks: [''] }, 200],
	['GET foreign origin', { method: 'GET', headers: { host: 'h', origin: 'http://evil' }, chunks: [''] }, 403],
	['GET null origin', { method: 'GET', headers: { host: 'h', origin: 'null' }, chunks: [''] }, 403],
	['GET cross-site', { method: 'GET', headers: { host: 'h', 'sec-fetch-site': 'cross-site' }, chunks: [''] }, 403],
	['PUT', { method: 'PUT', headers: { host: 'h' }, chunks: [''] }, 405],
	['POST wrong type', { headers: { host: 'h', 'content-type': 'text/plain' }, chunks: ['{"ns":"dsh-do","ops":[]}'] }, 415],
	['POST invalid json', { headers: { host: 'h', 'content-type': 'application/json' }, chunks: ['{'] }, 400],
	['POST empty ops', { headers: { host: 'h', 'content-type': 'application/json' }, chunks: ['{"ns":"dsh-do","ops":[]}'] }, 400],
	['POST oversize', { headers: { host: 'h', 'content-type': 'application/json' }, chunks: [Buffer.alloc(70_000)] }, 400],
	['POST ok', { headers: { host: 'h', 'content-type': 'application/json' }, chunks: ['{"ns":"dsh-do","ops":[{"op":"set","path":["enabled"],"value":true}],"expectedRevision":3}'] }, 200],
	['POST proto path', { headers: { host: 'h', 'content-type': 'application/json' }, chunks: ['{"ns":"dsh-do","ops":[{"op":"set","path":["__proto__","polluted"],"value":true}]}'] }, 200],
]
for (const [label, request, expected] of cases) {
	const result = await call(request)
	if (result.status !== expected) fail('route.cases', label, `expected ${expected}, got ${result.status} (${JSON.stringify(result.body)})`)
	if (label.includes('proto') && ({}).polluted !== undefined) fail('route.proto', label, 'prototype polluted through the route')
}
for (const [mode, expected] of [['conflict', 409], ['type', 400], ['boom', 500]]) {
	mutateMode = mode
	const result = await call({ headers: { host: 'h', 'content-type': 'application/json' }, chunks: ['{"ns":"dsh-do","ops":[{"op":"set","path":["enabled"],"value":true}]}'] })
	if (result.status !== expected) fail('route.errors', mode, `expected ${expected}, got ${result.status}`)
	if (mode === 'conflict' && result.body?.code !== 'SETTINGS_CONFLICT') fail('route.errors', 'conflict code', `missing machine code: ${JSON.stringify(result.body)}`)
}
mutateMode = 'ok'

// Fuzz the handler itself: malformed method/headers/chunks must never throw.
for (let i = 0; i < 300; i++) {
	const method = ['GET', 'POST', 'PUT', 'DELETE', undefined, 42][i % 6]
	const headers = i % 2 === 0 ? {} : { host: 'h', 'content-type': ['application/json', 'text/html', undefined][i % 3], origin: ['http://h', 'ftp://h', 'h', undefined][i % 4] }
	const chunks = [[], ['{'], ['{"ns":1,"ops":2}'], [Buffer.alloc(70_000)], ['not json']][i % 5]
	const { captured, response } = res()
	try {
		await handler(reqFrom(chunks, { method, headers }), response)
		if (!captured.ended) {
			// A 405 path sets Allow then json; every branch must end the response.
			fail('route.fuzz', `#${i}`, 'handler returned without ending the response')
		}
		if (captured.ended) {
			try {
				JSON.parse(captured.body)
			} catch {
				fail('route.fuzz', `#${i}`, 'non-JSON response body')
			}
		}
	} catch (error) {
		fail('route.fuzz', `#${i}`, error)
	}
}

// A pathological-but-legal body: huge ops array within the byte budget.
const manyOps = JSON.stringify({ ns: 'dsh-do', ops: new Array(4000).fill({ op: 'set', path: ['a'], value: 'b' }) })
const manyResult = await call({ headers: { host: 'h', 'content-type': 'application/json' }, chunks: [manyOps] })
notes.push(`route: 4000-op body (${manyOps.length} bytes) -> ${manyResult.status}`)

console.log('BRUTE_HTTP ' + JSON.stringify({ ok: failures.length === 0, failures, notes }))
for (const note of notes) console.error(`note: ${note}`)
for (const f of failures) console.error(`FAIL [${f.area}] ${f.label}: ${f.error}`)
process.exitCode = failures.length > 0 ? 1 : 0
