import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
	DEFAULT_INTERVAL_MS,
	MIN_INTERVAL_MS,
	executeLoopCommand,
	installLoopCommand,
	parseLoopCommand,
	phaseLabel,
	renderInterval,
	renderLoop,
} from '../lib/types/command.js'
import { LoopController } from '../lib/types/controller.js'
import { effectiveRounds } from '../lib/types/loop.js'

const logger = { info() {}, warn() {} }
const controller = () => new LoopController(undefined, logger)
const budget = () => 7
const noRounds = () => 0

test('parseLoopCommand reads control verbs before the objective grammar', () => {
	assert.deepEqual(parseLoopCommand(''), { kind: 'show' })
	assert.deepEqual(parseLoopCommand('   '), { kind: 'show' })
	assert.deepEqual(parseLoopCommand('status'), { kind: 'show' })
	assert.deepEqual(parseLoopCommand('pause'), { kind: 'pause' })
	assert.deepEqual(parseLoopCommand('resume'), { kind: 'resume' })
	assert.deepEqual(parseLoopCommand('clear'), { kind: 'cancel' })
	assert.deepEqual(parseLoopCommand('cancel'), { kind: 'cancel' })
	assert.deepEqual(parseLoopCommand('done'), { kind: 'done' })
	assert.deepEqual(parseLoopCommand('PAUSE'), { kind: 'pause' })
	assert.deepEqual(parseLoopCommand('edit'), { kind: 'invalid-edit' })
})

test('parseLoopCommand carries verb payloads and keeps verb words usable as objectives', () => {
	assert.deepEqual(parseLoopCommand('edit ship the release'), { kind: 'edit', objective: 'ship the release' })
	assert.deepEqual(parseLoopCommand('done all green'), { kind: 'done', summary: 'all green' })
	assert.deepEqual(parseLoopCommand('cancel user aborted'), { kind: 'cancel', reason: 'user aborted' })
	// A verb only wins when the whole remainder fits its own grammar, so a
	// sentence that merely starts with one stays an objective.
	assert.deepEqual(parseLoopCommand('status is unknown, keep digging'), {
		kind: 'start',
		objective: 'status is unknown, keep digging',
		intervalMs: DEFAULT_INTERVAL_MS,
	})
	assert.deepEqual(parseLoopCommand('pause the workers then resume'), {
		kind: 'start',
		objective: 'pause the workers then resume',
		intervalMs: DEFAULT_INTERVAL_MS,
	})
})

test('parseLoopCommand reads a leading interval token with Claude Code priority', () => {
	assert.deepEqual(parseLoopCommand('5m check the deploy'), { kind: 'start', objective: 'check the deploy', intervalMs: 300_000 })
	assert.deepEqual(parseLoopCommand('2h audit logs'), { kind: 'start', objective: 'audit logs', intervalMs: 7_200_000 })
	assert.deepEqual(parseLoopCommand('1d rotate keys'), { kind: 'start', objective: 'rotate keys', intervalMs: 86_400_000 })
	// Sub-minute cadences round up to the one-minute floor both tools use.
	assert.deepEqual(parseLoopCommand('30s poll'), { kind: 'start', objective: 'poll', intervalMs: MIN_INTERVAL_MS })
	// An interval with no objective has nothing to run, so it degrades to status.
	assert.deepEqual(parseLoopCommand('5m'), { kind: 'show' })
})

test('parseLoopCommand reads a trailing every-clause and leaves bare "every" alone', () => {
	assert.deepEqual(parseLoopCommand('check the deploy every 20m'), { kind: 'start', objective: 'check the deploy', intervalMs: 1_200_000 })
	assert.deepEqual(parseLoopCommand('check the deploy every 20 minutes'), { kind: 'start', objective: 'check the deploy', intervalMs: 1_200_000 })
	assert.deepEqual(parseLoopCommand('audit every 2 hours'), { kind: 'start', objective: 'audit', intervalMs: 7_200_000 })
	// "every" followed by anything that is not a time expression is objective text.
	assert.deepEqual(parseLoopCommand('check every PR'), { kind: 'start', objective: 'check every PR', intervalMs: DEFAULT_INTERVAL_MS })
	assert.deepEqual(parseLoopCommand('review every change'), { kind: 'start', objective: 'review every change', intervalMs: DEFAULT_INTERVAL_MS })
})

test('parseLoopCommand gives a leading interval token priority over a trailing clause', () => {
	assert.deepEqual(parseLoopCommand('5m check every 20m'), { kind: 'start', objective: 'check every 20m', intervalMs: 300_000 })
})

test('parseLoopCommand defaults to the ten-minute cadence with the whole input as objective', () => {
	assert.deepEqual(parseLoopCommand('refactor the parser'), { kind: 'start', objective: 'refactor the parser', intervalMs: DEFAULT_INTERVAL_MS })
})

test('renderInterval round-trips a cadence to the token parseLoopCommand accepts', () => {
	for (const [ms, token] of [[86_400_000, '1d'], [7_200_000, '2h'], [300_000, '5m'], [60_000, '1m']]) {
		assert.equal(renderInterval(ms), token)
		assert.deepEqual(parseLoopCommand(`${token} go`).intervalMs, ms)
	}
})

test('renderLoop reports phase, objective, budget and cadence without internals', () => {
	const loop = { id: 'l', sessionId: 's', objective: 'ship it', maxRounds: 5, intervalMs: 300_000, phase: 'active', armed: true, roundsStarted: 2, startedAt: 0, updatedAt: 0 }
	const text = renderLoop('Loop', loop, 2)
	assert.match(text, /^Loop\nStatus: active\n/)
	assert.match(text, /Objective: ship it/)
	assert.match(text, /Rounds: 2\/5/)
	assert.match(text, /Cadence: every 5m/)
	assert.equal(phaseLabel({ ...loop, armed: false }), 'paused')
	assert.equal(phaseLabel({ ...loop, phase: 'completed', armed: false }), 'complete')
	assert.equal(phaseLabel({ ...loop, phase: 'blocked', armed: false }), 'blocked')
	assert.equal(phaseLabel({ ...loop, phase: 'cancelled', armed: false }), 'cancelled')
	// An unpaced loop says so rather than inventing a cadence.
	assert.match(renderLoop('Loop', { ...loop, intervalMs: undefined }, 2), /Cadence: on idle/)
})

test('executeLoopCommand drives the full lifecycle through the registry', () => {
	const loops = controller()
	const run = (input) => executeLoopCommand(loops, parseLoopCommand(input), 's', budget, noRounds)

	const started = run('5m ship the release')
	assert.equal(started.kind, 'success')
	assert.match(started.text, /Loop started/)
	assert.equal(loops.get('s').objective, 'ship the release')
	assert.equal(loops.get('s').maxRounds, 7, 'the live settings reader supplies the budget')
	assert.equal(loops.get('s').intervalMs, 300_000)

	assert.match(run('').text, /Status: active/)
	assert.equal(run('pause').kind, 'success')
	assert.equal(loops.get('s').armed, false)
	assert.equal(run('resume').kind, 'success')
	assert.equal(loops.get('s').armed, true)
	assert.match(run('edit ship the hotfix').text, /Loop updated/)
	assert.equal(loops.get('s').objective, 'ship the hotfix')
	assert.equal(run('done all green').kind, 'success')
	assert.equal(loops.get('s').phase, 'completed')
	assert.equal(loops.get('s').armed, false)
})

test('executeLoopCommand refuses a second start while a loop is armed', () => {
	const loops = controller()
	const run = (input) => executeLoopCommand(loops, parseLoopCommand(input), 's', budget, noRounds)
	run('first objective')
	const refused = run('second objective')
	assert.equal(refused.kind, 'error')
	assert.match(refused.text, /already active/)
	assert.match(refused.text, /\/loop edit <objective>/)
	// The refusal is a refusal: the stored objective is untouched.
	assert.equal(loops.get('s').objective, 'first objective')
})

test('starting on a disarmed loop replaces its objective and budget, and says so', () => {
	// Overturned by explicit user decision: `start` used to re-arm a paused loop
	// and keep the stored objective, which made `/loop <objective>` silently
	// discard what the user typed. It now replaces the loop outright.
	const loops = controller()
	const run = (input) => executeLoopCommand(loops, parseLoopCommand(input), 's', budget, noRounds)
	run('the original objective')
	const originalId = loops.get('s').id
	run('pause')
	const restarted = run('a brand new objective')
	assert.equal(restarted.kind, 'success')
	assert.match(restarted.text, /Loop restarted/)
	assert.match(restarted.text, /replaced/)
	assert.equal(loops.get('s').objective, 'a brand new objective')
	assert.equal(loops.get('s').armed, true)
	// A fresh id is what actually resets the budget: admitted rounds are counted
	// from session events tagged with the loop id.
	assert.notEqual(loops.get('s').id, originalId)
	assert.equal(loops.get('s').roundsStarted, 0)
})

test('edit keeps the budget while start replaces it', () => {
	const loops = controller()
	const run = (input) => executeLoopCommand(loops, parseLoopCommand(input), 's', budget, noRounds)
	run('first objective')
	run('pause')
	// `edit` is the mid-flight correction path: same loop, spent rounds still count.
	const edited = run('edit a corrected objective')
	assert.equal(edited.kind, 'success')
	assert.match(edited.text, /Loop updated/)
	assert.equal(loops.get('s').objective, 'a corrected objective')
	assert.equal(loops.get('s').armed, false, 'edit does not change arming')
})

test('executeLoopCommand reports missing state instead of throwing', () => {
	const loops = controller()
	const run = (input) => executeLoopCommand(loops, parseLoopCommand(input), 's', budget, noRounds)
	assert.match(run('').text, /No loop is currently set/)
	assert.equal(run('pause').kind, 'error')
	assert.equal(run('resume').kind, 'error')
	assert.equal(run('edit x').kind, 'error')
	assert.equal(run('done').kind, 'error')
	assert.equal(run('cancel').kind, 'success')
	assert.match(run('cancel').text, /No loop to clear/)
})

test('executeLoopCommand starts a fresh loop when the stored one is terminal', () => {
	const loops = controller()
	const run = (input) => executeLoopCommand(loops, parseLoopCommand(input), 's', budget, noRounds)
	run('first')
	run('done')
	const restarted = run('second')
	assert.equal(restarted.kind, 'success')
	assert.match(restarted.text, /Loop started/)
	assert.equal(loops.get('s').objective, 'second')
	assert.equal(loops.get('s').phase, 'active')
})

test('executeLoopCommand reports the effective round count it was given', () => {
	const loops = controller()
	executeLoopCommand(loops, parseLoopCommand('go'), 's', budget, noRounds)
	const withRounds = executeLoopCommand(loops, parseLoopCommand(''), 's', budget, (loop) => effectiveRounds(undefined, loop) + 3)
	assert.match(withRounds.text, /Rounds: 3\/7/)
})

test('installLoopCommand registers one command gated on the command registry', () => {
	// The registration rides `ctx.inject(['commands'])`, so a profile without a
	// command registry never registers `/loop` instead of failing the plugin.
	let deps
	installLoopCommand({ inject: (names, _fn) => { deps = names } }, controller(), budget)
	assert.deepEqual(deps, ['commands'])
})

test('the registered /loop handler drives the live loop and returns UI outcomes', () => {
	const loops = controller()
	let definition
	const commands = { register: (def) => { definition = def; return () => {} } }
	const child = { commands, effect: (fn) => fn() }
	installLoopCommand({ inject: (_names, fn) => fn(child) }, loops, budget)

	assert.equal(definition.name, 'loop')
	assert.equal(typeof definition.description, 'string')
	assert.deepEqual(definition.input, { hint: '[<interval>] [<objective>|pause|resume|edit <objective>|done|cancel]' })
	assert.equal(typeof definition.handler, 'function')

	// The handler reads the session and the effective round count from the live
	// agent, so the report matches what the driver will admit next.
	const agent = { session: { id: 'live-session', events: [] } }
	const invoke = (rawInput) => definition.handler({ commandId: 'loop', agent, rawInput, attachments: [], signal: new AbortController().signal })

	const started = invoke('5m ship it')
	assert.equal(started.kind, 'success')
	assert.match(started.text, /Loop started/)
	assert.equal(loops.get('live-session').intervalMs, 300_000)
	assert.equal(loops.get('live-session').maxRounds, 7)

	const shown = invoke('')
	assert.match(shown.text, /Objective: ship it/)
	assert.match(shown.text, /Cadence: every 5m/)

	const cancelled = invoke('cancel done for today')
	assert.equal(cancelled.kind, 'success')
	assert.equal(loops.get('live-session').phase, 'cancelled')
	assert.equal(loops.get('live-session').cancelledReason, 'done for today')
})

// The two tests above use a hand-rolled registry, which cannot catch a mismatch
// with the shipped contract (required fields, descriptor shape, name rules).
// Mount the real CommandRuntime from @deepseek-ai/dsh-commands and resolve
// through it, exactly as a profile mounting both plugins would.
test('the real command registry accepts, resolves, and releases the /loop registration', async () => {
	const { Context } = await import('@deepseek-ai/cordis')
	const commands = (await import('@deepseek-ai/dsh-commands')).default

	const ctx = new Context()
	const service = ctx.plugin(commands)
	await service.await()
	const runtime = ctx.get('commands')

	// Mirror production: the plugin itself does not hard-inject `commands`;
	// installLoopCommand gates its own registration behind ctx.inject.
	const loops = controller()
	const plugin = ctx.plugin({
		name: 'dsh-do-command-contract',
		apply(child) {
			installLoopCommand(child, loops, budget)
		},
	})
	await plugin.await()

	const agent = { id: 'contract-agent', session: { id: 'contract-session', events: [] } }
	const descriptor = runtime.list(agent).find((entry) => entry.name === 'loop')
	assert.notEqual(descriptor, undefined, 'the real registry lists /loop')
	assert.equal(typeof descriptor.description, 'string')
	assert.ok(descriptor.description.length > 0, 'the real registry requires a human-readable description')

	const definition = runtime.find(agent, 'loop')
	assert.equal(definition.name, 'loop')
	assert.deepEqual(definition.input, { hint: '[<interval>] [<objective>|pause|resume|edit <objective>|done|cancel]' })

	// Drive the real resolved handler with a real invocation shape.
	const outcome = await definition.handler({
		commandId: 'loop',
		agent,
		rawInput: '5m through the real registry',
		attachments: [],
		signal: new AbortController().signal,
	})
	assert.equal(outcome.kind, 'success')
	assert.match(outcome.text, /Loop started/)
	assert.equal(loops.get('contract-session').objective, 'through the real registry')
	assert.equal(loops.get('contract-session').intervalMs, 300_000)

	// Unloading the plugin must release the name: a reload would otherwise either
	// duplicate the command or leave a stale handler bound to a dead controller.
	await plugin.dispose()
	await new Promise((resolve) => setTimeout(resolve, 20))
	assert.equal(runtime.find(agent, 'loop'), undefined, 'disposing the plugin releases /loop')
	await ctx.fiber.dispose()
})
