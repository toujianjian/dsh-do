import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { Config, installDoSettings, DSH_DO_NS } from '../lib/types/settings.js'
import { installSettingsRoute, parseSettingsWriteRequest, readSettingsView, SETTINGS_PATH } from '../lib/types/settings-route.js'
import {
	AGENT_DEFAULT_MODEL_NS,
	DEEPSEEK_NS,
	PI_AI_NS,
	RETRY_DEFAULTS,
	buildLoopSectionValue,
	buildRetryPolicy,
	buildRetryResetOps,
	buildRetrySaveOps,
	indexSections,
	isOverridden,
	readActiveModel,
	readLoopDraft,
	readRetryDraft,
	resolveRetryTargets,
	selectRetryTarget,
	validateLoopDraft,
	validateRetryDraft,
} from '../lib/types/client/doSettings.js'

const section = (ns, value, extra = {}) => ({ ns, value, revision: 0, ...extra })
const indexOf = (...sections) => indexSections(sections)

test('the settings bridge serves a stable same-origin path', () => {
	assert.equal(SETTINGS_PATH, '/dsh-do/settings')
})

test('parseSettingsWriteRequest accepts a well-formed path write', () => {
	const parsed = parseSettingsWriteRequest({ ns: PI_AI_NS, ops: [{ op: 'set', path: ['providers', 'huoshan', 'retryPolicy'], value: { mode: 'normal' } }], expectedRevision: 3 })
	assert.equal(parsed.ok, true)
	assert.deepEqual(parsed.request, {
		ns: PI_AI_NS,
		ops: [{ op: 'set', path: ['providers', 'huoshan', 'retryPolicy'], value: { mode: 'normal' } }],
		expectedRevision: 3,
	})
	// An unset needs no value, and an omitted revision is legal.
	const reset = parseSettingsWriteRequest({ ns: PI_AI_NS, ops: [{ op: 'unset', path: ['providers', 'huoshan', 'retryPolicy'] }] })
	assert.equal(reset.ok, true)
	assert.equal('expectedRevision' in reset.request, false)
	// An empty path is the section root: that is how the page saves the whole
	// dsh-do section in one revision-fenced write.
	const root = parseSettingsWriteRequest({ ns: 'dsh-do', ops: [{ op: 'set', path: [], value: { persist: true } }] })
	assert.equal(root.ok, true)
	assert.deepEqual(root.request.ops, [{ op: 'set', path: [], value: { persist: true } }])
})

test('parseSettingsWriteRequest rejects every malformed shape the page could be tricked into sending', () => {
	const bad = [
		[null, 'a JSON object is required'],
		['text', 'a JSON object is required'],
		[[], 'a JSON object is required'],
		[{}, 'ns must be a non-empty string'],
		[{ ops: [] }, 'ns must be a non-empty string'],
		[{ ns: '   ', ops: [] }, 'ns must be a non-empty string'],
		[{ ns: 7, ops: [] }, 'ns must be a non-empty string'],
		[{ ns: 'a' }, 'ops must be a non-empty array'],
		[{ ns: 'a', ops: [] }, 'ops must be a non-empty array'],
		[{ ns: 'a', ops: 'x' }, 'ops must be a non-empty array'],
		[{ ns: 'a', ops: [null] }, 'each op must be an object'],
		[{ ns: 'a', ops: [{ op: 'delete', path: ['x'] }] }, 'op must be "set" or "unset"'],
		[{ ns: 'a', ops: [{ op: 'set' }] }, 'path must be an array'],
		[{ ns: 'a', ops: [{ op: 'set', path: 'x' }] }, 'path must be an array'],
		[{ ns: 'a', ops: [{ op: 'set', path: [''] }] }, 'every path segment must be a non-empty string'],
		[{ ns: 'a', ops: [{ op: 'set', path: [1] }] }, 'every path segment must be a non-empty string'],
		[{ ns: 'a', ops: [{ op: 'set', path: ['x'] }] }, 'a set op requires a value'],
		[{ ns: 'a', ops: [{ op: 'unset', path: ['x'] }], expectedRevision: -1 }, 'expectedRevision must be a non-negative integer'],
		[{ ns: 'a', ops: [{ op: 'unset', path: ['x'] }], expectedRevision: 1.5 }, 'expectedRevision must be a non-negative integer'],
	]
	for (const [body, error] of bad) {
		const parsed = parseSettingsWriteRequest(body)
		assert.equal(parsed.ok, false, `expected rejection for ${JSON.stringify(body)}`)
		assert.equal(parsed.error, error)
	}
})

test('parseSettingsWriteRequest keeps an explicit null value, which is a legal JSON write', () => {
	const parsed = parseSettingsWriteRequest({ ns: 'a', ops: [{ op: 'set', path: ['x'], value: null }] })
	assert.equal(parsed.ok, true)
	assert.equal(parsed.request.ops[0].value, null)
})

test('readSettingsView narrows to the namespaces the page acts on', () => {
	const settings = {
		describe: () => [
			section('dsh-do', { defaultMaxRounds: 20 }, { user: { defaultMaxRounds: 9 } }),
			section('llm-pi-ai', { providers: { huoshan: {} } }),
			section('some-other-plugin', { secret: 'x' }),
			section(AGENT_DEFAULT_MODEL_NS, { provider: 'huoshan', model: 'm' }),
		],
	}
	const views = readSettingsView(settings)
	assert.deepEqual(views.map((view) => view.ns), ['dsh-do', 'llm-pi-ai', AGENT_DEFAULT_MODEL_NS])
	assert.equal(views.some((view) => view.ns === 'some-other-plugin'), false)
	// The user layer rides along so the page can mark overrides; absent means absent.
	assert.deepEqual(views[0].user, { defaultMaxRounds: 9 })
	assert.equal('user' in views[1], false)
})

test('readRetryDraft falls back to the Host built-in defaults', () => {
	const empty = readRetryDraft(undefined, ['retryPolicy'])
	assert.deepEqual(empty, RETRY_DEFAULTS)
	// An unrelated provider shape must not leak into the form.
	assert.deepEqual(readRetryDraft({ providers: {} }, ['providers', 'huoshan', 'retryPolicy']), RETRY_DEFAULTS)
	assert.deepEqual(readRetryDraft({ retryPolicy: 'nonsense' }, ['retryPolicy']), RETRY_DEFAULTS)
})

test('readRetryDraft reads a nested pi-ai policy and ignores wrong-typed fields', () => {
	const value = {
		providers: {
			huoshan: { retryPolicy: { mode: 'always', maxRetries: 9, backoff: { initialDelayMs: 250, maxDelayMs: 4000, jitterRatio: 0.25 } } },
		},
	}
	assert.deepEqual(readRetryDraft(value, ['providers', 'huoshan', 'retryPolicy']), {
		mode: 'always',
		maxRetries: 9,
		initialDelayMs: 250,
		maxDelayMs: 4000,
		jitterRatio: 0.25,
	})
	const mixed = { retryPolicy: { mode: 'bogus', maxRetries: 'lots', backoff: { initialDelayMs: null } } }
	assert.deepEqual(readRetryDraft(mixed, ['retryPolicy']), RETRY_DEFAULTS)
})

test('validateRetryDraft enforces the Host constraints the page can predict', () => {
	const base = { mode: 'normal', maxRetries: 5, initialDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0.1 }
	assert.equal(validateRetryDraft(base), undefined)
	assert.equal(validateRetryDraft({ ...base, maxRetries: 0 }), undefined)
	assert.match(validateRetryDraft({ ...base, maxRetries: -1 }), /最大重试次数/)
	assert.match(validateRetryDraft({ ...base, maxRetries: 1.5 }), /必须是整数/)
	assert.match(validateRetryDraft({ ...base, initialDelayMs: -1 }), /初始退避时长/)
	assert.match(validateRetryDraft({ ...base, maxDelayMs: 2_147_483_648 }), /最大退避时长/)
	// An inverted backoff range would make the adapter's own schema fail.
	assert.match(validateRetryDraft({ ...base, initialDelayMs: 9000, maxDelayMs: 100 }), /不能大于/)
	assert.match(validateRetryDraft({ ...base, jitterRatio: 1.5 }), /抖动比例/)
	assert.match(validateRetryDraft({ ...base, jitterRatio: -0.1 }), /抖动比例/)
	assert.match(validateRetryDraft({ ...base, jitterRatio: Number.NaN }), /抖动比例/)
	// `always` ignores maxRetries, so an out-of-range value there is not a problem.
	assert.equal(validateRetryDraft({ ...base, mode: 'always', maxRetries: -5 }), undefined)
})

test('buildRetryPolicy always carries mode, and never invents fields the schema rejects', () => {
	const normal = buildRetryPolicy({ mode: 'normal', maxRetries: 8, initialDelayMs: 100, maxDelayMs: 2000, jitterRatio: 0.2 })
	assert.deepEqual(normal, { mode: 'normal', maxRetries: 8, backoff: { initialDelayMs: 100, maxDelayMs: 2000, jitterRatio: 0.2 } })
	// `always` omits maxRetries: the always-schema does not declare it, and a
	// partial write without `mode` would be refused by the required-field rule.
	const always = buildRetryPolicy({ mode: 'always', maxRetries: 8, initialDelayMs: 100, maxDelayMs: 2000, jitterRatio: 0.2 })
	assert.deepEqual(always, { mode: 'always', backoff: { initialDelayMs: 100, maxDelayMs: 2000, jitterRatio: 0.2 } })
	// retryableCodes stays absent so the adapter keeps its built-in code list.
	for (const policy of [normal, always]) {
		assert.equal('retryableCodes' in policy, false)
		assert.equal(policy.mode !== undefined, true)
	}
})

test('retry save and reset address the nested provider path, not the whole map', () => {
	const piAi = { id: 'huoshan', namespace: PI_AI_NS, label: 'huoshan', path: ['providers', 'huoshan', 'retryPolicy'] }
	const draft = { mode: 'normal', maxRetries: 3, initialDelayMs: 100, maxDelayMs: 900, jitterRatio: 0 }
	assert.deepEqual(buildRetrySaveOps(piAi, draft), [
		{ op: 'set', path: ['providers', 'huoshan', 'retryPolicy'], value: { mode: 'normal', maxRetries: 3, backoff: { initialDelayMs: 100, maxDelayMs: 900, jitterRatio: 0 } } },
	])
	// Reset clears exactly the policy, so every other provider field survives.
	assert.deepEqual(buildRetryResetOps(piAi), [{ op: 'unset', path: ['providers', 'huoshan', 'retryPolicy'] }])
	const deepseek = { id: 'deepseek-official', namespace: DEEPSEEK_NS, label: 'x', path: ['retryPolicy'] }
	assert.deepEqual(buildRetryResetOps(deepseek), [{ op: 'unset', path: ['retryPolicy'] }])
})

test('resolveRetryTargets offers only the policies the deployment serves', () => {
	assert.deepEqual(resolveRetryTargets(indexOf()), [])
	const onlyDeepseek = resolveRetryTargets(indexOf(section(DEEPSEEK_NS, {})))
	assert.deepEqual(onlyDeepseek.map((target) => target.namespace), [DEEPSEEK_NS])
	assert.deepEqual(onlyDeepseek[0].path, ['retryPolicy'])
	const both = resolveRetryTargets(indexOf(section(DEEPSEEK_NS, {}), section(PI_AI_NS, { providers: { zeta: {}, alpha: {} } })))
	assert.deepEqual(both.map((target) => target.id), ['deepseek-official', 'alpha', 'zeta'])
	assert.deepEqual(both[1].path, ['providers', 'alpha', 'retryPolicy'])
	// A pi-ai section with no providers contributes nothing.
	assert.deepEqual(resolveRetryTargets(indexOf(section(PI_AI_NS, { providers: {} }))), [])
	assert.deepEqual(resolveRetryTargets(indexOf(section(PI_AI_NS, { providers: [] }))), [])
})

test('selectRetryTarget opens on the active provider and falls back to the first', () => {
	const targets = resolveRetryTargets(indexOf(section(DEEPSEEK_NS, {}), section(PI_AI_NS, { providers: { alpha: {}, zeta: {} } })))
	assert.equal(selectRetryTarget(targets, { provider: 'zeta' }).id, 'zeta')
	// A deepseek-family route with no exact match still lands on the adapter.
	assert.equal(selectRetryTarget(targets, { provider: 'deepseek-chat' }).id, 'deepseek-official')
	assert.equal(selectRetryTarget(targets, {}).id, 'deepseek-official')
	assert.equal(selectRetryTarget(targets, { provider: 'unserved' }).id, 'deepseek-official')
	assert.equal(selectRetryTarget([], { provider: 'x' }), undefined)
	const onlyPiAi = resolveRetryTargets(indexOf(section(PI_AI_NS, { providers: { alpha: {}, zeta: {} } })))
	assert.equal(selectRetryTarget(onlyPiAi, {}).id, 'alpha')
})

test('readActiveModel reads only real strings', () => {
	assert.deepEqual(readActiveModel({ provider: 'huoshan', model: 'ark-code-latest' }), { provider: 'huoshan', model: 'ark-code-latest' })
	assert.deepEqual(readActiveModel({ provider: '', model: 7 }), {})
	assert.deepEqual(readActiveModel(undefined), {})
})

test('isOverridden reads presence in the user layer, not value equality', () => {
	const user = { defaultMaxRounds: 20, providers: { huoshan: { retryPolicy: { mode: 'normal' } } } }
	assert.equal(isOverridden(user, ['defaultMaxRounds']), true)
	assert.equal(isOverridden(user, ['providers', 'huoshan', 'retryPolicy']), true)
	assert.equal(isOverridden(user, ['providers', 'huoshan', 'missing']), false)
	assert.equal(isOverridden(user, ['providers', 'absent', 'retryPolicy']), false)
	assert.equal(isOverridden(undefined, ['defaultMaxRounds']), false)
	assert.equal(isOverridden({ defaultMaxRounds: undefined }, ['defaultMaxRounds']), false)
})

test('readLoopDraft and validateLoopDraft round-trip the plugin section', () => {
	const draft = readLoopDraft({
		defaultMaxRounds: 12,
		checkpointDir: '/tmp/loops',
		persist: false,
		loopDetection: { enabled: false, repeatThreshold: 6, compact: false, maxInterventions: 4 },
	})
	assert.deepEqual(draft, {
		defaultMaxRounds: '12',
		checkpointDir: '/tmp/loops',
		persist: false,
		detectionEnabled: false,
		repeatThreshold: '6',
		detectionCompact: false,
		maxInterventions: '4',
		continueEnabled: true,
		maxContinuations: '3',
		continueOnlyWhileLooping: true,
		fallbackEnabled: false,
		fallbackCandidates: '',
		fallbackCodes: 'RATE_LIMIT, QUOTA, SERVER, TIMEOUT, TRANSPORT, EMPTY_RESPONSE',
	})
	assert.equal(validateLoopDraft(draft), undefined)
	// Absent fields fall back to the schema defaults the Host would resolve.
	assert.deepEqual(readLoopDraft(undefined), {
		defaultMaxRounds: '20',
		checkpointDir: '',
		persist: true,
		detectionEnabled: true,
		repeatThreshold: '4',
		detectionCompact: true,
		maxInterventions: '2',
		continueEnabled: true,
		maxContinuations: '3',
		continueOnlyWhileLooping: true,
		fallbackEnabled: false,
		fallbackCandidates: '',
		fallbackCodes: 'RATE_LIMIT, QUOTA, SERVER, TIMEOUT, TRANSPORT, EMPTY_RESPONSE',
	})
	// The fallback section round-trips, including multi-slash model ids.
	const fb = readLoopDraft({ modelFallback: { enabled: true, candidates: ['openai/gpt-4o', 'openrouter/anthropic/claude'], triggerCodes: ['RATE_LIMIT'] }, autoContinue: { enabled: false, maxContinuations: 5, onlyWhileLooping: false } })
	assert.equal(fb.fallbackEnabled, true)
	assert.equal(fb.fallbackCandidates, 'openai/gpt-4o\nopenrouter/anthropic/claude')
	assert.equal(fb.fallbackCodes, 'RATE_LIMIT')
	assert.equal(fb.continueEnabled, false)
	assert.equal(fb.maxContinuations, '5')
	assert.equal(fb.continueOnlyWhileLooping, false)
})

test('validateLoopDraft rejects values the Host schema would refuse', () => {
	const ok = readLoopDraft(undefined)
	assert.equal(validateLoopDraft(ok), undefined)
	assert.match(validateLoopDraft({ ...ok, defaultMaxRounds: '0' }), /默认最大轮次/)
	assert.match(validateLoopDraft({ ...ok, defaultMaxRounds: 'many' }), /默认最大轮次/)
	assert.match(validateLoopDraft({ ...ok, defaultMaxRounds: '1.5' }), /默认最大轮次/)
	// A threshold of 1 would fire on the first call, which is not a repeat.
	assert.match(validateLoopDraft({ ...ok, repeatThreshold: '1' }), /循环检测阈值/)
	assert.match(validateLoopDraft({ ...ok, maxInterventions: '0' }), /最大干预次数/)
	assert.match(validateLoopDraft({ ...ok, maxContinuations: '0' }), /自动继续/)
	assert.match(validateLoopDraft({ ...ok, fallbackCandidates: 'no-slash' }), /provider\/model/)
	assert.match(validateLoopDraft({ ...ok, fallbackEnabled: true, fallbackCandidates: '' }), /至少要填一个候选模型/)
	assert.equal(validateLoopDraft({ ...ok, fallbackEnabled: true, fallbackCandidates: 'openai/gpt-4o\nopenrouter/anthropic/claude' }), undefined)
})

test('buildLoopSectionValue writes the whole section the Host schema validates', () => {
	const value = buildLoopSectionValue({
		...readLoopDraft(undefined),
		defaultMaxRounds: '9',
		checkpointDir: '  /tmp/x  ',
		persist: false,
		repeatThreshold: '3',
		detectionCompact: false,
		maxInterventions: '5',
		continueEnabled: false,
		maxContinuations: '4',
		fallbackEnabled: true,
		fallbackCandidates: 'openai/gpt-4o\n moonshot/kimi-k2 ',
		fallbackCodes: 'rate_limit, server',
	})
	assert.deepEqual(value, {
		defaultMaxRounds: 9,
		checkpointDir: '/tmp/x',
		persist: false,
		loopDetection: { enabled: true, repeatThreshold: 3, compact: false, maxInterventions: 5 },
		autoContinue: { enabled: false, maxContinuations: 4, onlyWhileLooping: true },
		modelFallback: { enabled: true, candidates: ['openai/gpt-4o', 'moonshot/kimi-k2'], triggerCodes: ['RATE_LIMIT', 'SERVER'] },
	})
	// The browser form and the Host schema agree: what the form writes resolves unchanged.
	assert.deepEqual(Config(value), value)
})

// ---------------------------------------------------------------------------
// Integration: the real route and the real namespace installation, driven by a
// minimal settings service that applies the shipped path-op semantics.
// ---------------------------------------------------------------------------

/** Apply one path op exactly as `dsh-settings`'s `applyPathOp` does. */
function applyPathOp(section, op) {
	const [head, ...rest] = op.path
	if (head === undefined) return op.op === 'unset' ? {} : { ...op.value }
	if (rest.length === 0) {
		if (op.op === 'set') return { ...section, [head]: op.value }
		const { [head]: _removed, ...kept } = section
		return kept
	}
	const child = section[head]
	if (child === null || typeof child !== 'object' || Array.isArray(child)) {
		if (op.op === 'unset') return section
		return { ...section, [head]: applyPathOp({}, { ...op, path: rest }) }
	}
	return { ...section, [head]: applyPathOp(child, { ...op, path: rest }) }
}

/** Deep merge where the later layer wins, mirroring the shipped resolver's shape. */
function mergeLayer(base, overlay) {
	if (overlay === null || typeof overlay !== 'object' || Array.isArray(overlay)) return overlay === undefined ? base : overlay
	if (base === null || typeof base !== 'object' || Array.isArray(base)) return { ...overlay }
	const merged = { ...base }
	for (const [key, value] of Object.entries(overlay)) merged[key] = key in base ? mergeLayer(base[key], value) : value
	return merged
}

/**
 * A minimal in-memory settings service: enough of `register`/`describe`/`mutate`
 * to exercise the real namespace installation and the real bridge route,
 * including revision fencing and base-over-user resolution.
 */
function memorySettings() {
	const registrations = new Map()
	const resolved = (registration) => mergeLayer(registration.base ?? {}, registration.section)
	return {
		register(ns, schema, options = {}) {
			if (registrations.has(ns)) throw new Error(`settings namespace "${ns}" is already registered`)
			const registration = { schema, base: options.base, section: {}, revision: 0, watchers: new Set() }
			registrations.set(ns, registration)
			return {
				get: () => resolved(registration),
				watch: (callback) => {
					registration.watchers.add(callback)
					return () => registration.watchers.delete(callback)
				},
			}
		},
		describe() {
			return [...registrations].map(([ns, registration]) => ({
				ns,
				value: resolved(registration),
				revision: registration.revision,
				...(Object.keys(registration.section).length === 0 ? {} : { user: registration.section }),
			}))
		},
		async mutate(ns, ops, expectedRevision) {
			const registration = registrations.get(ns)
			if (registration === undefined) throw new Error(`settings namespace "${ns}" is not registered`)
			if (expectedRevision !== undefined && expectedRevision !== registration.revision) {
				// The shipping service marks a stale revision with the documented
				// SETTINGS_CONFLICT machine code, and a wire layer keys on that code
				// rather than on the message. A fake that omitted it would make the
				// route look wrong for reading the real contract.
				const conflict = new Error(`settings namespace "${ns}" moved past revision ${expectedRevision}`)
				conflict.code = 'SETTINGS_CONFLICT'
				throw conflict
			}
			registration.section = ops.reduce(applyPathOp, registration.section)
			registration.revision += 1
			for (const watcher of [...registration.watchers]) watcher()
			return { revision: registration.revision }
		},
		/** Test-only probe: the raw user layer. */
		raw: (ns) => registrations.get(ns)?.section,
		has: (ns) => registrations.has(ns),
	}
}

/** Drive the real route through a fake transport, capturing the registered handler. */
function bridge(settings) {
	let handler
	const child = {
		get: (name) => (name === 'settings' ? settings : { register(spec) { assert.equal(spec.kind, 'exact'); assert.equal(spec.path, SETTINGS_PATH); handler = spec.handler; return () => {} } }),
		effect: (fn) => fn(),
	}
	installSettingsRoute({ inject: (_deps, fn) => fn(child) })
	assert.equal(typeof handler, 'function', 'the route registered a handler')
	return async (method = 'GET', body, headers = {}) => {
		const req = Readable.from(body === undefined ? [] : [Buffer.from(body)])
		req.method = method
		req.headers = { host: '127.0.0.1:3080', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }
		let payload
		const res = { setHeader() {}, end(text) { payload = JSON.parse(text) } }
		await handler(req, res)
		return { status: res.statusCode, body: payload }
	}
}

test('the dsh-do namespace registers against a real settings service and follows its live value', async () => {
	const settings = memorySettings()
	const applied = []
	// `installSettingsSection` reads `ctx.fiber.state` to skip re-publishing during
	// unload, so the fake context needs an active fiber (Cordis ACTIVE === 2).
	const child = { settings, effect: (fn) => fn() }
	const ctx = { inject: (_deps, fn) => fn(child), effect: (fn) => fn(), fiber: { state: 2 } }
	const entry = { defaultMaxRounds: 20, checkpointDir: '', persist: true, loopDetection: { enabled: true, repeatThreshold: 4, compact: true, maxInterventions: 2 } }
	const source = installDoSettings(ctx, entry, (next) => applied.push(next))

	assert.equal(settings.has(DSH_DO_NS), true, 'the namespace is registered on the settings service')
	// Before any user write the resolved value is the composition entry, so the
	// plugin behaves exactly as composed and nothing is re-applied.
	assert.deepEqual(source.read(), entry)
	assert.equal(applied.length, 0)

	// A committed user section re-publishes through onChange, so the loop tools,
	// the driver, and the detection policy all see the new value without a restart.
	await settings.mutate(DSH_DO_NS, [{ op: 'set', path: [], value: { defaultMaxRounds: 3, persist: false } }])
	assert.equal(applied.length, 1)
	assert.equal(applied[0].defaultMaxRounds, 3)
	assert.equal(applied[0].persist, false)
	// Fields the user did not override still resolve from the composition layer.
	assert.equal(applied[0].checkpointDir, '')
	assert.equal(applied[0].loopDetection.repeatThreshold, 4)
	assert.equal(source.read().defaultMaxRounds, 3, 'the live reader follows the committed section')
	// A structurally identical re-read is not re-applied.
	await settings.mutate(DSH_DO_NS, [{ op: 'set', path: ['persist'], value: false }])
	assert.equal(applied.length, 1)
})

test('the settings bridge serves only the namespaces the page acts on', async () => {
	const settings = memorySettings()
	settings.register('dsh-do', {}, {})
	settings.register('llm-pi-ai', {}, {})
	settings.register('unrelated', {}, {})
	await settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'huoshan', 'retryPolicy'], value: { mode: 'normal', maxRetries: 5 } }])
	const request = bridge(settings)

	const listed = await request()
	assert.equal(listed.status, 200)
	assert.deepEqual(listed.body.sections.map((section) => section.ns), ['dsh-do', 'llm-pi-ai'])
	// The nested policy is served as-is, which is what the page's path reader expects.
	const piAi = listed.body.sections.find((section) => section.ns === 'llm-pi-ai')
	assert.deepEqual(readRetryDraft(piAi.value, ['providers', 'huoshan', 'retryPolicy']).maxRetries, 5)
	assert.equal(typeof piAi.revision, 'number')
})

test('the settings bridge writes a nested retry policy without touching sibling fields', async () => {
	const settings = memorySettings()
	settings.register('llm-pi-ai', {}, {})
	await settings.mutate('llm-pi-ai', [
		{ op: 'set', path: ['providers', 'huoshan', 'apiKey'], value: 'secret-value' },
		{ op: 'set', path: ['providers', 'huoshan', 'retryPolicy'], value: { mode: 'normal', maxRetries: 5 } },
		{ op: 'set', path: ['providers', 'other', 'retryPolicy'], value: { mode: 'normal' } },
	])
	const request = bridge(settings)
	const target = { id: 'huoshan', namespace: PI_AI_NS, label: 'x', path: ['providers', 'huoshan', 'retryPolicy'] }

	const saved = await request('POST', JSON.stringify({ ns: PI_AI_NS, ops: buildRetrySaveOps(target, { mode: 'always', maxRetries: 5, initialDelayMs: 250, maxDelayMs: 3000, jitterRatio: 0.3 }) }))
	assert.equal(saved.status, 200)
	const providers = settings.raw(PI_AI_NS).providers
	assert.deepEqual(providers.huoshan.retryPolicy, { mode: 'always', backoff: { initialDelayMs: 250, maxDelayMs: 3000, jitterRatio: 0.3 } })
	assert.equal(providers.huoshan.apiKey, 'secret-value', 'a sibling field survives the nested write')
	assert.deepEqual(providers.other.retryPolicy, { mode: 'normal' }, 'another provider is untouched')
	// The response is a fresh projection, so the page can adopt it directly.
	assert.equal(saved.body.sections.some((section) => section.ns === PI_AI_NS), true)

	const reset = await request('POST', JSON.stringify({ ns: PI_AI_NS, ops: buildRetryResetOps(target) }))
	assert.equal(reset.status, 200)
	assert.equal('retryPolicy' in settings.raw(PI_AI_NS).providers.huoshan, false, 'a reset clears only the policy path')
	assert.equal(settings.raw(PI_AI_NS).providers.huoshan.apiKey, 'secret-value')
})

test('the settings bridge fences a stale revision instead of overwriting a concurrent change', async () => {
	const settings = memorySettings()
	settings.register('dsh-do', {}, {})
	const request = bridge(settings)
	const first = await request('POST', JSON.stringify({ ns: 'dsh-do', ops: [{ op: 'set', path: [], value: { defaultMaxRounds: 3 } }], expectedRevision: 0 }))
	assert.equal(first.status, 200)
	// A second writer that read revision 0 is refused, and the stored value stands.
	const stale = await request('POST', JSON.stringify({ ns: 'dsh-do', ops: [{ op: 'set', path: [], value: { defaultMaxRounds: 99 } }], expectedRevision: 0 }))
	assert.equal(stale.status, 409)
	assert.equal(stale.body.code, 'SETTINGS_CONFLICT', 'the machine code is echoed so the page can branch without parsing prose')
	assert.match(stale.body.error, /moved past revision 0/)
	assert.equal(settings.raw('dsh-do').defaultMaxRounds, 3)
	// Re-reading the revision and retrying succeeds.
	const retry = await request('POST', JSON.stringify({ ns: 'dsh-do', ops: [{ op: 'set', path: [], value: { defaultMaxRounds: 99 } }], expectedRevision: 1 }))
	assert.equal(retry.status, 200)
	assert.equal(settings.raw('dsh-do').defaultMaxRounds, 99)
})

test('the settings bridge refuses an unregistered namespace and reports why', async () => {
	const settings = memorySettings()
	const request = bridge(settings)
	const response = await request('POST', JSON.stringify({ ns: 'not-registered', ops: [{ op: 'set', path: ['x'], value: 1 }] }))
	// A namespace the deployment does not compose is a server-side condition, not
	// a stale revision: the shipping service reports it without the
	// SETTINGS_CONFLICT code, so the route must not tell the page to reload.
	assert.equal(response.status, 500)
	assert.match(response.body.error, /is not registered/)
	assert.equal(response.body.code, undefined)
})

test('a request error from the service is not reported as a stale revision', async () => {
	const settings = memorySettings()
	settings.register('dsh-do', {}, {})
	// The shipping service raises a TypeError for a malformed op or a value that
	// is not JSON-compatible. That is the caller's fault, so it must not become a
	// 409 that tells the page its copy is stale.
	const typed = {
		describe: settings.describe,
		mutate: async () => {
			throw new TypeError('settings mutate for "dsh-do" must contain only JSON-compatible data')
		},
	}
	const request = bridge(typed)
	const response = await request('POST', JSON.stringify({ ns: 'dsh-do', ops: [{ op: 'set', path: ['persist'], value: true }] }))
	assert.equal(response.status, 400)
	assert.equal(response.body.code, undefined)
	assert.match(response.body.error, /JSON-compatible/)
})

test('the settings bridge guards method, origin, content type and body before any write', async () => {
	const settings = memorySettings()
	settings.register('dsh-do', {}, {})
	let writes = 0
	const guarded = { ...settings, mutate: async (...args) => { writes++; return settings.mutate(...args) } }

	/** Drive the real handler with fully controlled headers. */
	const raw = async (method, headers, body) => {
		let handler
		const child = { get: (name) => (name === 'settings' ? guarded : { register(spec) { handler = spec.handler; return () => {} } }), effect: (fn) => fn() }
		installSettingsRoute({ inject: (_deps, fn) => fn(child) })
		const req = Readable.from(body === undefined ? [] : [Buffer.from(body)])
		req.method = method
		req.headers = { host: '127.0.0.1:3080', ...headers }
		let payload
		const res = { setHeader() {}, end(text) { payload = JSON.parse(text) } }
		await handler(req, res)
		return { status: res.statusCode, body: payload }
	}

	assert.equal((await raw('DELETE', {}, undefined)).status, 405)
	assert.equal((await raw('GET', { origin: 'https://evil.example' }, undefined)).status, 403)
	assert.equal((await raw('GET', { 'sec-fetch-site': 'cross-site' }, undefined)).status, 403)
	assert.equal((await raw('GET', { origin: 'http://127.0.0.1:3080' }, undefined)).status, 200)
	assert.equal((await raw('POST', { 'content-type': 'text/plain' }, '{}')).status, 415)
	assert.equal((await raw('POST', {}, '{}')).status, 415)
	assert.equal((await raw('POST', { 'content-type': 'application/json' }, '{bad')).status, 400)
	assert.equal((await raw('POST', { 'content-type': 'application/json' }, '{}')).status, 400)
	assert.equal(writes, 0, 'no rejected request reached the settings service')
})

test('the settings bridge is not installed without a settings service', () => {
	let injected
	installSettingsRoute({ inject: (deps, _fn) => { injected = deps } })
	assert.deepEqual(injected, ['webServer', 'settings'])
})
