/**
 * Tier 2: load + abuse against a REAL running web deployment.
 *
 * Expects PORT/TOKEN (see start-web020.sh). The deployment's settings service
 * is the real file-backed provider, so this exercises the plugin's own route
 * end to end: origin guard, body budget, status taxonomy, and behaviour when
 * the host itself refuses the write (0.2.x: "profile reload requires the root
 * Include entry").
 */
import http from 'node:http'

const PORT = Number(process.env.PORT ?? 3199)
const HOST = process.env.HOST ?? '127.0.0.1'
const TOKEN = process.env.TOKEN
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 })

const results = { statuses: {}, failures: [], notes: [] }
const record = (label, status) => {
	results.statuses[label] = results.statuses[label] ?? {}
	results.statuses[label][status] = (results.statuses[label][status] ?? 0) + 1
}
const fail = (label, detail) => results.failures.push({ label, detail })

function rawCall(method, path, { headers = {}, body, timeoutMs = 10_000 } = {}) {
	return new Promise((resolve) => {
		let settled = false
		const done = (value) => {
			if (settled) return
			settled = true
			resolve(value)
		}
		const req = http.request(
			{ host: HOST, port: PORT, path, method, agent, headers: { host: `${HOST}:${PORT}`, ...headers } },
			(res) => {
				const chunks = []
				res.on('data', (chunk) => chunks.push(chunk))
				res.on('end', () => {
					const text = Buffer.concat(chunks).toString('utf8')
					let json
					try {
						json = JSON.parse(text)
					} catch {
						json = undefined
					}
					done({ status: res.statusCode, headers: res.headers, text, json })
				})
				res.on('error', (error) => done({ status: 'error', error: error.code ?? error.message, text: '', json: undefined }))
			},
		)
		req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')))
		req.on('error', (error) => done({ status: 'error', error: error.code ?? error.message, text: '', json: undefined }))
		if (body !== undefined) req.write(body)
		req.end()
	})
}

/**
 * One retry for idempotent requests: a keep-alive socket that the server closed
 * (405s and 500s may close the connection) would otherwise surface as a stale
 * socket error and look like a server outage.
 */
async function call(method, path, options = {}) {
	const first = await rawCall(method, path, options)
	if (first.status !== 'error' || method !== 'GET') return first
	return rawCall(method, path, options)
}

// ---------------------------------------------------------------- auth
const landing = await call('GET', `/?token=${encodeURIComponent(TOKEN)}`, { headers: {} })
record('auth landing', landing.status)
const cookie = (landing.headers?.['set-cookie'] ?? []).map((value) => value.split(';')[0]).join('; ')
if (cookie === '') fail('auth', `no session cookie (status ${landing.status})`)
const auth = { cookie }
results.notes.push(`landing ${landing.status}, cookie ${cookie === '' ? '(none)' : 'ok'}`)

const SETTINGS = '/dsh-do/settings'
const jsonHeaders = { ...auth, 'content-type': 'application/json' }
const read = () => call('GET', SETTINGS, { headers: auth })

// ---------------------------------------------------------------- baseline
const base = await read()
record('GET baseline', base.status)
if (base.status !== 200 || base.json?.ok !== true) fail('GET baseline', `${base.status} ${String(base.text).slice(0, 160)}`)
const sections = base.json?.sections ?? []
// The route serves whatever namespace the registered section actually has; on
// this deployment it is `do`, not the package name, so discover it rather than
// assuming.
const doSection = sections.find((entry) => entry?.value !== null && typeof entry?.value === 'object' && 'defaultMaxRounds' in entry.value)
if (doSection === undefined) fail('baseline', `no dsh-do section among: ${sections.map((entry) => entry.ns).join(',')}`)
const NS = doSection?.ns ?? 'dsh-do'
results.notes.push(`sections=${sections.map((entry) => entry.ns).join(',')} | dsh-do namespace=${NS} revision=${doSection?.revision}`)
const writeBody = (revision, value = 7) => JSON.stringify({ ns: NS, ops: [{ op: 'set', path: ['defaultMaxRounds'], value }], expectedRevision: revision })

function classifyWrite(label, result) {
	record(label, result.status)
	if (result.status === 'error') {
		fail(label, `transport error: ${result.error}`)
		return
	}
	if (result.status === 200 || result.status === 409) return
	if (result.status === 500 && /profile reload requires the root Include entry/.test(String(result.text))) {
		// Known host-side limitation of 0.2.x (documented in docs/verification.md):
		// the write is refused by the platform, not by this plugin's parser.
		results.notes.push(`${label}: host refused the write (0.2.x profile Include limitation)`)
		return
	}
	fail(label, `unexpected ${result.status} ${String(result.text).slice(0, 160)}`)
}

// ---------------------------------------------------------------- bursts
// 250 concurrent reads.
for (const result of await Promise.all(Array.from({ length: 250 }, () => read()))) {
	record('GET burst', result.status)
	if (result.status !== 200 || result.json?.ok !== true || !Array.isArray(result.json?.sections)) fail('GET burst', `bad response ${result.status} ${String(result.text).slice(0, 120)}`)
}

// 120 stale writes at once.
for (const result of await Promise.all(Array.from({ length: 120 }, () => call('POST', SETTINGS, { headers: jsonHeaders, body: writeBody(0) })))) {
	classifyWrite('POST stale revision', result)
	if (result.status === 409 && result.json?.code !== 'SETTINGS_CONFLICT') fail('POST stale revision', `missing machine code: ${String(result.text).slice(0, 120)}`)
}

// 80 writes racing on one live revision.
const liveRevision = (await read()).json?.sections?.find((entry) => entry.ns === NS)?.revision ?? 0
for (const result of await Promise.all(Array.from({ length: 80 }, (_, index) => call('POST', SETTINGS, { headers: jsonHeaders, body: writeBody(liveRevision, 7 + (index % 3)) })))) {
	classifyWrite('POST racing revision', result)
}

// Abuse shapes, 10 rounds each. Each case lists its acceptable statuses.
const abuse = [
	['wrong content-type', 'POST', { ...auth, 'content-type': 'text/plain' }, '{}', [415]],
	['invalid json', 'POST', jsonHeaders, '{', [400]],
	['empty ops', 'POST', jsonHeaders, JSON.stringify({ ns: NS, ops: [] }), [400]],
	['root scalar set', 'POST', jsonHeaders, JSON.stringify({ ns: NS, ops: [{ op: 'set', path: [], value: 5 }] }), [400]],
	['cross origin', 'POST', { ...jsonHeaders, origin: 'http://evil.example' }, writeBody(liveRevision), [403]],
	['cross site', 'POST', { ...jsonHeaders, 'sec-fetch-site': 'cross-site' }, writeBody(liveRevision), [403]],
	['unknown namespace', 'POST', jsonHeaders, JSON.stringify({ ns: 'no-such-ns', ops: [{ op: 'set', path: ['a'], value: 1 }] }), [400, 500]],
	['proto path', 'POST', jsonHeaders, JSON.stringify({ ns: NS, ops: [{ op: 'set', path: ['__proto__', 'polluted'], value: true }] }), [200, 400, 409, 500]],
	['put', 'PUT', jsonHeaders, '{}', [405]],
	['delete', 'DELETE', jsonHeaders, '', [405]],
	['head', 'HEAD', auth, undefined, [405, 200]],
]
for (let round = 0; round < 10; round++) {
	for (const [label, method, headers, body, expected] of abuse) {
		const result = await call(method, SETTINGS, { headers, body, timeoutMs: 5_000 })
		record(`abuse ${label}`, result.status)
		if (result.status === 'error') {
			if (method === 'HEAD' && result.error.startsWith('ECONNRESET')) continue
			fail(`abuse ${label}`, `transport error: ${result.error}`)
			continue
		}
		if (!expected.includes(result.status)) fail(`abuse ${label}`, `expected ${expected.join('/')}, got ${result.status} ${String(result.text).slice(0, 120)}`)
		if (result.text !== '' && result.json === undefined && method !== 'HEAD') fail(`abuse ${label}`, 'non-JSON response body')
		if (result.status === 500 && result.json?.error !== undefined && /No configurable plugin entry/.test(String(result.text))) {
			results.notes.push(`abuse ${label}: unknown namespace reported as 500 (documented taxonomy)`)
		}
	}
}

// Oversize body: the server rejects it while the client is still uploading, so
// either a 400 or a reset is acceptable — a hang or a 5xx is not.
const oversize = await call('POST', SETTINGS, { headers: jsonHeaders, body: 'x'.repeat(200_000), timeoutMs: 8_000 })
record('abuse oversize', oversize.status)
results.notes.push(`oversize body -> ${oversize.status}${oversize.error ? ` (${oversize.error})` : ''}`)
if (oversize.status !== 400 && oversize.status !== 'error') fail('abuse oversize', `expected 400 or reset, got ${oversize.status}`)

// ---------------------------------------------------------------- aftermath
const after = await read()
record('GET after', after.status)
const afterSection = after.json?.sections?.find((entry) => entry.ns === NS)
if (after.status !== 200) fail('GET after', `${after.status}`)
if (afterSection === undefined) fail('GET after', `${NS} disappeared from the projection`)
results.notes.push(`after: ${NS} revision ${doSection?.revision} -> ${afterSection?.revision}, defaultMaxRounds=${JSON.stringify(afterSection?.value?.defaultMaxRounds)}`)
if (({}).polluted !== undefined) fail('proto', 'Object.prototype polluted in the client process')

agent.destroy()
console.log('BRUTE_WEB ' + JSON.stringify({ ok: results.failures.length === 0, ...results }, null, 2))
process.exitCode = results.failures.length > 0 ? 1 : 0
