/**
 * Tier 1: pure-function brute force.
 *
 * Invariants under test: exported parsers/builders/renderers never throw on
 * hostile input, and any value they DO accept stays inside the documented
 * domain (a parser that accepts an out-of-domain record is as bad as a crash
 * because it becomes a lie on the status surface).
 */
import { rng, randomValue, mutateJson, deepChain, randomCommandText } from './gen.mjs'
import * as checkpoint from './lib/types/checkpoint.js'
import * as command from './lib/types/command.js'
import * as configcmd from './lib/types/config-command.js'
import * as loop from './lib/types/loop.js'
import * as status from './lib/types/loop-status.js'
import * as detect from './lib/types/loop-detect.js'
import * as prompt from './lib/types/prompt.js'
import * as mfallback from './lib/types/model-fallback.js'
import * as acont from './lib/types/auto-continue.js'
import * as sroute from './lib/types/settings-route.js'
import * as settings from './lib/types/settings.js'
import * as source from './lib/types/source.js'

const r = rng(0xbadf00d)
const failures = []
const notes = []
const counts = new Map()
let total = 0

function bump(area) {
	counts.set(area, (counts.get(area) ?? 0) + 1)
	total++
}

function fail(area, label, error) {
	failures.push({
		area,
		label,
		error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
		stack: error instanceof Error ? String(error.stack ?? '').split('\n').slice(0, 4).join(' | ') : '',
	})
}

function probe(area, label, fn) {
	bump(area)
	try {
		return fn()
	} catch (error) {
		fail(area, label, error)
		return undefined
	}
}

function invariant(area, label, condition, detail) {
	if (!condition) fail(area, label, new Error(`invariant violated: ${detail}`))
}

const PHASES = new Set(['active', 'completed', 'blocked', 'cancelled'])
const PAUSES = new Set(['round-cancelled', 'round-aborted', 'max-tokens', 'agent-error', 'driver-failed', 'restart'])

function validLoop(overrides = {}) {
	return loop.createLoop({ sessionId: 'session-1', objective: 'do the thing', maxRounds: 3, ...overrides })
}

// ---------------------------------------------------------------- checkpoint
const validDoc = () => JSON.parse(checkpoint.serializeCheckpoint(validLoop({ intervalMs: 60_000 })))

function assertLoopDomain(area, state, label) {
	invariant(area, label, typeof state.id === 'string' && /^[A-Za-z0-9_-]+$/.test(state.id), 'id')
	invariant(area, label, typeof state.sessionId === 'string' && state.sessionId.length > 0, 'sessionId')
	invariant(area, label, typeof state.objective === 'string', 'objective')
	invariant(area, label, Number.isSafeInteger(state.maxRounds) && state.maxRounds >= 1, 'maxRounds')
	invariant(area, label, PHASES.has(state.phase), 'phase')
	invariant(area, label, typeof state.armed === 'boolean', 'armed')
	invariant(area, label, Number.isSafeInteger(state.roundsStarted) && state.roundsStarted >= 0, 'roundsStarted')
	invariant(area, label, Number.isFinite(state.startedAt) && Number.isFinite(state.updatedAt), 'timestamps')
	if (state.phase !== 'active') invariant(area, label, state.armed === false, 'terminal phase must be disarmed')
	if (state.pausedReason !== undefined) {
		invariant(area, label, PAUSES.has(state.pausedReason.code), 'pause code')
		invariant(area, label, state.phase === 'active' && state.armed === false, 'pause must imply active+disarmed')
	}
	if (state.intervalMs !== undefined) {
		invariant(area, label, Number.isSafeInteger(state.intervalMs) && state.intervalMs >= 1 && state.intervalMs <= loop.MAX_TIMER_DELAY_MS, 'intervalMs')
	}
}

for (let i = 0; i < 4000; i++) {
	const text = probe('checkpoint.parse', `random value #${i}`, () => JSON.stringify(randomValue(r)))
	if (typeof text !== 'string') continue
	probe('checkpoint.parse', `random json #${i}`, () => {
		const parsed = checkpoint.parseCheckpoint(text, 'loop-fuzz.json')
		invariant('checkpoint.parse', `shape #${i}`, typeof parsed === 'object' && typeof parsed.ok === 'boolean', 'result is not {ok}')
		if (parsed.ok) {
			assertLoopDomain('checkpoint.parse', parsed.loop, `random #${i}`)
			// A record this parser accepts must survive its own serialization.
			const again = checkpoint.parseCheckpoint(checkpoint.serializeCheckpoint(parsed.loop), 'loop-fuzz.json')
			invariant('checkpoint.parse', `roundtrip #${i}`, again.ok === true, 'accepted record failed to round-trip')
		}
	})
}

for (let i = 0; i < 4000; i++) {
	const doc = mutateJson(validDoc(), r)
	probe('checkpoint.mutate', `mutation #${i}`, () => {
		const parsed = checkpoint.parseCheckpoint(JSON.stringify(doc), 'loop-fuzz.json')
		if (parsed.ok) assertLoopDomain('checkpoint.mutate', parsed.loop, `mutation #${i}`)
	})
}

const checkpointEdges = [
	['', 'empty'],
	['null', 'null'],
	['[]', 'array'],
	['{"version":1}', 'no loop'],
	['{"version":1,"loop":null}', 'null loop'],
	['{"version":"1","loop":{}}', 'string version'],
	['{"version":1,"loop":{"id":"../x","sessionId":"s","objective":"o","maxRounds":1,"phase":"active","armed":true,"roundsStarted":0,"startedAt":0,"updatedAt":0}}', 'traversal id'],
	['{"version":1,"loop":{"id":"ok","sessionId":"","objective":"o","maxRounds":1,"phase":"active","armed":true,"roundsStarted":0,"startedAt":0,"updatedAt":0}}', 'empty session'],
	['{"version":1,"loop":{"id":"ok","sessionId":"s","objective":"o","maxRounds":0,"phase":"active","armed":true,"roundsStarted":0,"startedAt":0,"updatedAt":0}}', 'zero rounds'],
	['{"version":1,"loop":{"id":"ok","sessionId":"s","objective":"o","maxRounds":1,"phase":"active","armed":true,"roundsStarted":-1,"startedAt":0,"updatedAt":0}}', 'negative rounds'],
	['{"version":1,"loop":{"id":"ok","sessionId":"s","objective":"o","maxRounds":1,"phase":"completed","armed":true,"roundsStarted":0,"startedAt":0,"updatedAt":0}}', 'armed terminal'],
	['{"version":1,"loop":{"id":"ok","sessionId":"s","objective":"o","maxRounds":1,"phase":"active","armed":false,"pausedReason":{"code":"nope","message":"m","at":1},"roundsStarted":0,"startedAt":0,"updatedAt":0}}', 'bad pause code'],
	['{"version":1,"loop":{"id":"ok","sessionId":"s","objective":"o","maxRounds":1,"phase":"active","armed":false,"pausedReason":{"code":"restart","message":"m","at":1e309},"roundsStarted":0,"startedAt":0,"updatedAt":0}}', 'infinite pause at'],
	['{"version":1,"loop":{"id":"ok","sessionId":"s","objective":"o","maxRounds":1,"phase":"active","armed":true,"intervalMs":2147483648,"roundsStarted":0,"startedAt":0,"updatedAt":0}}', 'interval too large'],
	['{"version":1,"loop":{"id":"ok","sessionId":"s","objective":"o","maxRounds":1,"phase":"active","armed":true,"intervalMs":1.5,"roundsStarted":0,"startedAt":0,"updatedAt":0}}', 'fractional interval'],
	['{"version":1,"loop":{"id":"ok","sessionId":"s","objective":"o","maxRounds":1,"phase":"active","armed":true,"roundsStarted":0,"startedAt":null,"updatedAt":0}}', 'null timestamp'],
	['{"version":1,"loop":{"id":"ok","sessionId":"s","objective":"o","maxRounds":1,"phase":"active","armed":true,"roundsStarted":0,"startedAt":0,"updatedAt":0,"__proto__":{"polluted":true}}}', 'proto extra field'],
	['{"version":1,"loop":{"id":"ok","sessionId":"s","objective":"'+ 'x'.repeat(2_000_000) +'","maxRounds":1,"phase":"active","armed":true,"roundsStarted":0,"startedAt":0,"updatedAt":0}}', '2MB objective'],
]
for (const [text, label] of checkpointEdges) {
	probe('checkpoint.edges', label, () => {
		const parsed = checkpoint.parseCheckpoint(text, 'loop-edge.json')
		if (parsed.ok) assertLoopDomain('checkpoint.edges', parsed.loop, label)
		invariant('checkpoint.edges', `${label} target`, ({}.polluted) === undefined, 'prototype polluted by parse')
	})
}

// ---------------------------------------------------------------- /loop parser
for (let i = 0; i < 6000; i++) {
	const text = i % 100 === 0 ? randomCommandText(r) + 'x'.repeat(50_000) : randomCommandText(r)
	probe('command.parse', `#${i}`, () => {
		const parsed = command.parseLoopCommand(text)
		invariant('command.parse', `kind #${i}`, ['show', 'start', 'pause', 'resume', 'edit', 'done', 'cancel', 'invalid-edit'].includes(parsed.kind), 'unknown kind')
		if (parsed.kind === 'start') {
			invariant('command.parse', `objective #${i}`, parsed.objective.trim().length > 0, 'empty objective')
			invariant('command.parse', `interval #${i}`, Number.isSafeInteger(parsed.intervalMs) && parsed.intervalMs >= command.MIN_INTERVAL_MS && parsed.intervalMs <= command.MAX_INTERVAL_MS, `interval out of bounds: ${parsed.intervalMs}`)
		}
	})
}
const commandEdges = [
	['60s hot', 'start', 60_000], ['59s hot', 'start', 60_000], ['1d hot', 'start', 86_400_000],
	['2147483647s hot', 'start', 2_147_483_647], ['2147483648s hot', 'start', command.MAX_INTERVAL_MS],
	['99999999999999999999s hot', 'start', command.DEFAULT_INTERVAL_MS], ['hot every 30s', 'start', 60_000],
	['hot every 1 second', 'start', 1_000 * 1 < 60_000 ? 60_000 : 60_000], ['hot every 1h', 'start', 3_600_000],
	['hot every 0m', 'start', command.DEFAULT_INTERVAL_MS], ['hot every 999999999999999999999d', 'start', command.DEFAULT_INTERVAL_MS],
	['pause', 'pause'], ['Pause', 'pause'], ['pause extra', 'start'], ['done', 'done'], ['done all good', 'done'],
	['cancel', 'cancel'], ['clear', 'cancel'], ['status', 'show'], ['status x', 'start'], ['edit', 'invalid-edit'],
	['edit new objective', 'edit'], ['', 'show'], ['   ', 'show'], ['1m', 'show'],
	['\u0000', 'start'], ['😀', 'start'], ['every 5m then more', 'start'],
]
for (const [text, kind, interval] of commandEdges) {
	probe('command.edges', JSON.stringify(text).slice(0, 40), () => {
		const parsed = command.parseLoopCommand(text)
		invariant('command.edges', `${JSON.stringify(text)} kind`, parsed.kind === kind, `expected ${kind}, got ${parsed.kind}`)
		if (kind === 'start' && interval !== undefined) invariant('command.edges', `${JSON.stringify(text)} interval`, parsed.intervalMs === interval, `expected ${interval}, got ${parsed.intervalMs}`)
	})
}

for (const value of [...Array(200).keys(), NaN, Infinity, -Infinity, -1, 0, 1.5, 2_147_483_647, 1e21]) {
	probe('command.renderInterval', String(value), () => {
		const text = command.renderInterval(value)
		invariant('command.renderInterval', String(value), typeof text === 'string' && text.length > 0, 'empty render')
	})
	probe('command.phaseLabel', String(value), () => {
		const state = { ...validLoop(), phase: value, armed: value === 'active' }
		command.phaseLabel(state)
	})
}

// ---------------------------------------------------------------- /do-config
for (let i = 0; i < 3000; i++) {
	probe('config.parse', `#${i}`, () => {
		const parsed = configcmd.parseConfigCommand(randomCommandText(r))
		invariant('config.parse', `kind #${i}`, ['list', 'file', 'show', 'set', 'reset'].includes(parsed.kind), 'unknown kind')
	})
}
for (const field of configcmd.CONFIG_FIELDS) {
	const raws = ['', ' ', '0', '-1', '1e309', 'NaN', 'Infinity', 'true', '开', '关闭', '\(', '["a","b"]', '[' + 'a,'.repeat(50_000) + ']', 'x'.repeat(200_000), '\u0000', '😀']
	for (const raw of raws) {
		probe('config.coerce', `${field.path} ${raw.slice(0, 12)}`, () => {
			const result = configcmd.coerceValue(field, raw)
			invariant('config.coerce', `${field.path} shape`, typeof result.ok === 'boolean', 'no ok flag')
			if (result.ok && field.type === 'integer') invariant('config.coerce', `${field.path} int domain`, Number.isSafeInteger(result.value) && (field.min === undefined || result.value >= field.min), `out-of-domain integer ${result.value}`)
		})
	}
	probe('config.findField', field.path, () => configcmd.findField(field.path))
	probe('config.findField', `${field.path.toLowerCase()} suffix`, () => configcmd.findField(field.path.split('.').slice(-1)[0]))
}
for (const value of [null, undefined, 0, -1, NaN, Infinity, '', 'x'.repeat(50_000), [], [1, null, 'x'], {}, [[]], '😀\u0000\ud800']) {
	probe('config.format', String(value).slice(0, 20), () => {
		const text = configcmd.formatSetting(value)
		invariant('config.format', String(value).slice(0, 20), typeof text === 'string', 'not a string')
	})
	probe('config.readPath', String(JSON.stringify(value)).slice(0, 20), () => configcmd.readPath(value, 'a.b.c'))
}
const hostileResolved = [
	null, undefined, {}, [], 'x', 42,
	{ enabled: 'yes', checkpointDir: 'x'.repeat(10_000) },
	{ autoContinue: { enabled: 1 }, loopDetection: { repeatThreshold: NaN } },
	JSON.parse('{"__proto__":{"a":1},"enabled":false}'),
]
for (const resolved of hostileResolved) {
	probe('config.render', JSON.stringify(resolved)?.slice(0, 30) ?? 'undefined', () => {
		const lines = configcmd.renderConfigListing(resolved)
		invariant('config.render', 'lines', Array.isArray(lines) && lines.every((line) => typeof line === 'string'), 'non-string line')
		const colored = configcmd.renderConfigListing(resolved, { color: true })
		invariant('config.render', 'colored lines', Array.isArray(colored) && colored.every((line) => typeof line === 'string'), 'non-string colored line')
	})
}
for (let i = 0; i < 2000; i++) {
	const text = i % 10 === 0 ? '\u001b[1m'.repeat(1000) + 'x'.repeat(1000) : Array.from({ length: Math.floor(r() * 40) }, () => randomValue(r, 4, 4)).join('').toString()
	probe('config.displayWidth', `#${i}`, () => {
		const width = configcmd.displayWidth(String(text))
		invariant('config.displayWidth', `#${i}`, Number.isFinite(width) && Number.isInteger(width) && width >= 0, `bad width ${width}`)
	})
}

// ---------------------------------------------------------------- loop state machine
const hostileObjectives = ['', ' ', '\u0000', '\ud800', '😀'.repeat(1000), 'x'.repeat(5_000_000), 'line1\nline2\r\t', '-'.repeat(1000)]
for (const objective of hostileObjectives) {
	probe('loop.create', `objective ${objective.length}`, () => {
		const state = loop.createLoop({ sessionId: 's'.repeat(10_000), objective, maxRounds: 3 })
		probe('loop.status', `objective ${objective.length}`, () => {
			const view = status.loopStatusView(state)
			const line = status.renderLoopStatusLine(view)
			invariant('loop.status', 'line', typeof line === 'string' && line.length > 0, 'empty status line')
		})
		probe('loop.render', `objective ${objective.length}`, () => command.renderLoop('title', state, 1))
		probe('loop.prompt', `objective ${objective.length}`, () => prompt.renderLoopRoundPrompt(objective, 1, 3))
		probe('loop.serialize', `objective ${objective.length}`, () => checkpoint.serializeCheckpoint(state))
	})
}
for (const maxRounds of [1, 0, -1, 1.5, NaN, Infinity, 1e308, 2_147_483_648]) {
	probe('loop.create', `maxRounds ${maxRounds}`, () => {
		const state = loop.createLoop({ sessionId: 's', objective: 'o', maxRounds })
		probe('loop.render', `maxRounds ${maxRounds}`, () => command.renderLoop('t', state, 0))
	})
}
for (const n of [-1, 0, 1.5, NaN, Infinity, 1e308]) {
	probe('loop.transitions', `round ${n}`, () => {
		const state = validLoop()
		loop.markRoundAdmitted(state, n)
		loop.armLoop(state, Boolean(n % 2))
		loop.markPaused(state, { code: 'restart', message: 'm' })
		loop.markCompleted(state, 'sum')
		loop.markBlocked(state, { code: 'x', message: 'y' })
		loop.markCancelled(state, 'reason')
		loop.editLoopObjective(state, 'new')
		loop.isRunning(state)
	})
}
const fakeAgents = [
	undefined, {}, { session: null }, { session: {} }, { session: { id: 's' } },
	{ session: { events: () => { throw new Error('boom') } } },
]
for (const agent of fakeAgents) {
	probe('loop.effectiveRounds', String(agent), () => {
		const state = validLoop()
		const rounds = loop.effectiveRounds(agent, state)
		invariant('loop.effectiveRounds', 'finite', Number.isSafeInteger(rounds) && rounds >= 0, `bad rounds ${rounds}`)
	})
}

// ---------------------------------------------------------------- status surface
const statusLoops = [
	validLoop(), validLoop({ intervalMs: 1 }), validLoop({ intervalMs: loop.MAX_TIMER_DELAY_MS }),
	{ ...validLoop(), phase: 'completed' }, { ...validLoop(), phase: 'blocked', blockedReason: { code: 'x', message: 'm' } },
	{ ...validLoop(), phase: 'cancelled', cancelledReason: 'r' },
	{ ...validLoop(), phase: 'active', armed: false, pausedReason: { code: 'restart', message: 'm', at: 1 } },
	{ ...validLoop(), phase: undefined }, { ...validLoop(), objective: undefined }, { ...validLoop(), maxRounds: NaN },
	{ ...validLoop(), maxRounds: Infinity, roundsStarted: Infinity }, { ...validLoop(), intervalMs: NaN },
]
for (const state of statusLoops) {
	probe('status.view', JSON.stringify(state).slice(0, 40), () => {
		const view = status.loopStatusView(state)
		const line = status.renderLoopStatusLine(view)
		invariant('status.view', 'line', typeof line === 'string' && line.length > 0, 'empty line')
	})
}
for (let i = 0; i < 1000; i++) {
	probe('status.projection', `#${i}`, () => {
		const raw = randomValue(r, 0, 4)
		// The registry only ever replays session events, i.e. objects; a null
		// event is not a reachable input and would test the harness, not the code.
		const event = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
		status.applyLoopProjection(i % 2 === 0 ? null : { loopId: 'l', roundsStarted: i, lastRoundAt: null }, event)
	})
}

// ---------------------------------------------------------------- loop detection
for (let i = 0; i < 1500; i++) {
	const value = randomValue(r, 0, 6)
	probe('detect.canonical', `#${i}`, () => {
		const canonical = detect.canonicalizeArguments(value)
		invariant('detect.canonical', `string #${i}`, typeof canonical === 'string', 'not a string')
		if (canonical.length < 1_000_000) {
			const again = detect.canonicalizeArguments(JSON.parse(canonical))
			if (again !== canonical) {
				let at = 0
				while (at < canonical.length && canonical[at] === again[at]) at++
				fail('detect.canonical', `idempotent #${i}`, new Error(`not idempotent at ${at}: ${JSON.stringify(canonical.slice(Math.max(0, at - 60), at + 120))} -> ${JSON.stringify(again.slice(Math.max(0, at - 60), at + 120))}`))
			}
		}
	})
}
for (const depth of [10, 1000, 5000, 20_000, 100_000]) {
	probe('detect.deep', `object depth ${depth}`, () => detect.canonicalizeArguments(deepChain(depth)))
	probe('detect.deep', `array depth ${depth}`, () => detect.canonicalizeArguments(deepChain(depth, [1], true)))
}
for (const [label, value] of [
	['bigint', 1n], ['symbol', Symbol('s')], ['function', () => 1], ['undefined', undefined],
	['sparse', new Array(1000)], ['huge string', 'x'.repeat(5_000_000)],
	['getter throws', { get a() { throw new Error('boom') } }],
]) {
	// Only JSON-domain values reach this module in production; these are
	// programmatic misuses, recorded as notes rather than failures.
	try {
		detect.canonicalizeArguments(value)
	} catch (error) {
		notes.push(`detect non-JSON input ${label}: ${error instanceof Error ? error.message : String(error)}`)
	}
}
const chains = [
	{ key: '["a","{}"]', count: 1 }, { key: '["a","{}"]', count: 1e9 }, { key: '["a","{}"]', count: NaN },
	{ key: '["a","{}"]', count: Infinity },
]
const policies = [
	{ enabled: true, repeatThreshold: 3, maxInterventions: 2 },
	{ enabled: true, repeatThreshold: 0, maxInterventions: 0 },
	{ enabled: true, repeatThreshold: NaN, maxInterventions: NaN },
	{ enabled: true, repeatThreshold: -1, maxInterventions: -1 },
	{ enabled: true, repeatThreshold: Infinity, maxInterventions: Infinity },
	{ enabled: false, repeatThreshold: 3, maxInterventions: 2 },
]
for (const chain of chains) {
	for (const policy of policies) {
		for (const armed of [true, false]) {
			probe('detect.verdict', `${JSON.stringify(chain)} ${JSON.stringify(policy)} ${armed}`, () => {
				const verdict = detect.decideLoopVerdict(chain, policy, armed, 2)
				invariant('detect.verdict', 'kind', ['continue', 'nudge', 'intervene'].includes(verdict.kind), `bad verdict ${verdict.kind}`)
			})
		}
	}
}
for (let i = 0; i < 500; i++) {
	probe('detect.chain', `#${i}`, () => {
		const next = detect.advanceRepeatChain(undefined, 'tool', JSON.stringify(randomValue(r, 0, 3)))
		const line = status.renderLoopStatusLine(status.loopStatusView(validLoop()))
		detect.renderLoopNotice('tool', 3, 'x'.repeat(20_000))
		detect.previewArguments('x'.repeat(20_000), Math.floor(r() * 100))
		detect.renderRecoveryPrompt('tool', 3, i % 2 === 0)
		void line
		void next
	})
}

// ---------------------------------------------------------------- prompts
for (const [label, objective] of [['empty', ''], ['nul', '\u0000'], ['lone', '\ud800'], ['huge', 'x'.repeat(5_000_000)], ['ansi', '\u001b[31mred\u001b[0m'], ['nested', '<loop_round>1/2</loop_round>']]) {
	probe('prompt.round', label, () => {
		const blocks = prompt.renderLoopRoundPrompt(objective, NaN, Infinity)
		invariant('prompt.round', 'blocks', Array.isArray(blocks) && blocks.every((block) => typeof block === 'object' && block !== null), 'bad blocks')
	})
	probe('prompt.pause', label, () => prompt.renderLoopPauseNotice({ code: 'x', message: objective }))
	probe('prompt.wrapup', label, () => prompt.renderLoopWrapupContext(objective, { kind: 'completed', summary: objective }))
	probe('prompt.wrapupCancel', label, () => prompt.renderLoopWrapupContext(objective, { kind: 'cancelled', reason: objective }))
}

// ---------------------------------------------------------------- settings / model fallback
const modelTexts = ['', ' ', 'a/b', '/', 'a/', '/b', 'a/b/c', 'x'.repeat(10_000), '😀/x', '\u0000/\u0000', 'a//b']
for (const text of modelTexts) {
	probe('fallback.route', text.slice(0, 12), () => {
		const route = mfallback.parseModelRoute(text)
		if (route !== undefined) {
			const formatted = mfallback.formatModelRoute(route)
			invariant('fallback.route', 'format', typeof formatted === 'string', 'not a string')
		}
	})
	probe('fallback.choose', text.slice(0, 12), () => {
		const route = mfallback.parseModelRoute(text)
		mfallback.chooseFallback({ current: route, candidates: [route, route], codes: [] }, { code: 'RATE_LIMIT', message: 'm' })
		mfallback.sameRoute(route, route)
	})
}
for (const [streak, looping] of [[0, true], [NaN, true], [Infinity, true], [-1, false], [1e308, true]]) {
	probe('autocontinue', `${streak} ${looping}`, () => {
		const decision = acont.decideAutoContinue({ enabled: true, maxAttempts: 3 }, streak, looping)
		invariant('autocontinue', 'kind', typeof decision.kind === 'string', 'no kind')
		acont.describeAutoContinueStop('exhausted', NaN)
		acont.renderAutoContinuePrompt(NaN, Infinity)
	})
}

// ---------------------------------------------------------------- settings route parser
for (let i = 0; i < 3000; i++) {
	probe('settings.parse', `#${i}`, () => {
		const result = sroute.parseSettingsWriteRequest(randomValue(r, 0, 5))
		invariant('settings.parse', 'ok flag', typeof result.ok === 'boolean', 'no ok flag')
	})
}
const settingsBodies = [
	{ ns: 'dsh-do', ops: [{ op: 'set', path: ['__proto__', 'polluted'], value: true }] },
	{ ns: 'dsh-do', ops: [{ op: 'set', path: [], value: { __proto__: { polluted: true } } }] },
	{ ns: 'dsh-do', ops: [{ op: 'set', path: ['constructor', 'prototype', 'polluted'], value: true }] },
	{ ns: 'dsh-do', ops: new Array(100_000).fill({ op: 'set', path: ['a'], value: 1 }) },
	{ ns: ' ', ops: [{ op: 'set', path: ['a'], value: 1 }] },
	{ ns: 'x', ops: [{ op: 'set', path: ['a'.repeat(100_000)], value: 'y'.repeat(100_000) }] },
	{ ns: 'x', ops: [{ op: 'set', path: [], value: new Date() }] },
	{ ns: 'x', ops: [{ op: 'set', path: [], value: [] }] },
	{ ns: 'x', ops: [{ op: 'unset', path: [] }] },
	{ ns: 'x', ops: [{ op: 'set', path: ['a'], value: 1 }], expectedRevision: -1 },
	{ ns: 'x', ops: [{ op: 'set', path: ['a'], value: 1 }], expectedRevision: 1.5 },
	{ ns: 'x', ops: [{ op: 'set', path: ['a'], value: 1 }], expectedRevision: 9_007_199_254_740_992 },
	{ ns: 'x', ops: [Object.defineProperty({}, 'op', { get() { throw new Error('boom') }, enumerable: true })] },
]
for (const [index, body] of settingsBodies.entries()) {
	// A parsed JSON body can never contain accessors; index 12 is a
	// programmatic misuse, recorded as a note.
	if (index === 12) {
		try {
			sroute.parseSettingsWriteRequest(body)
		} catch (error) {
			notes.push(`settings non-JSON op object: ${error instanceof Error ? error.message : String(error)}`)
		}
		continue
	}
	probe('settings.edges', `#${index}`, () => {
		const result = sroute.parseSettingsWriteRequest(body)
		invariant('settings.edges', 'proto', ({}).polluted === undefined, 'prototype polluted by parser')
		void result
	})
}
for (const value of [null, undefined, {}, { enabled: true }, { enabled: 'x' }, { nested: { deep: { deep: 1 } } }, JSON.parse('{"__proto__":{"x":1}}')]) {
	probe('settings.plain', JSON.stringify(value)?.slice(0, 30) ?? 'undefined', () => settings.plainSettings(value))
	probe('settings.isDoSection', JSON.stringify(value)?.slice(0, 30) ?? 'undefined', () => settings.isDoSection('dsh-do', value))
}

// ---------------------------------------------------------------- source helpers
for (const value of [undefined, null, 0, '', 'x', {}, { kind: 'dsh-do' }, { kind: 'loop', loopId: 'l', round: 1 }, { source: { kind: 'dsh-do' } }, []]) {
	probe('source.guards', JSON.stringify(value) ?? 'undefined', () => {
		source.isDoSource(value)
		loop.isLoopSource(value)
	})
}
probe('source.notice', 'x'.repeat(1000), () => source.doNoticeSource('x'.repeat(100_000)))

// ---------------------------------------------------------------- report
const report = {
	ok: failures.length === 0,
	total,
	areas: Object.fromEntries([...counts.entries()].sort()),
	failures,
	notes,
}
console.log('BRUTE_PURE ' + JSON.stringify(report))
if (failures.length > 0) {
	console.error(`\n${failures.length} failure(s):`)
	for (const f of failures.slice(0, 40)) console.error(`- [${f.area}] ${f.label}: ${f.error}${f.stack ? `\n    ${f.stack}` : ''}`)
}
process.exitCode = failures.length > 0 ? 1 : 0
