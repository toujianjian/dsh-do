import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Inbox } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { installLoopDriver } from '../lib/types/driver.js'
import { LoopController } from '../lib/types/controller.js'

const human = (text = 'Please handle this first') => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const deferred = () => {
	let resolve
	const promise = new Promise((done) => { resolve = done })
	return { promise, resolve }
}

// Fake only the live agent/event shell. Use the shipped Inbox so splice,
// claim, discard, and notification ordering match the actual runtime contract.
// followup enters running synchronously; steps and idle are advanced explicitly.
async function harness(t, { maxRounds = 3, initialMessages = [], restore, intervalMs, deferStart = false, wireNotifier = false, autoContinue } = {}) {
	const listeners = new Map()
	const warnings = []
	const runs = new Set()
	const effects = []
	const cancellations = []
	const queued = []
	const notices = []
	const human$1 = []
	const logger = { info() {}, warn(message) { warnings.push(message) } }
	const controller = new LoopController(undefined, logger)
	const emit = (name, ...args) => {
		for (const listener of [...(listeners.get(name) ?? [])]) listener(...args)
	}
	const session = {
		id: 'driver-session', header: {}, events: [],
		append(type, data) {
			const event = { seq: this.events.length, type, data }
			this.events.push(event)
			emit('session/event', this, event)
			return event
		},
	}
	const idleWaiters = []
	const agent = {
		id: session.id, session, status: 'idle',
		followup(message) {
			// Rounds, driver notices, and human turns share one followup channel in
			// production. Keep them apart here so a round assertion cannot be
			// satisfied by an announcement, and a notice assertion cannot be
			// satisfied by the human's own message.
			const kind = message.source?.kind
			if (kind === 'loop') queued.push(message)
			else if (kind === 'plugin') notices.push(message)
			else human$1.push(message)
			this.inbox.append('next-turn', message)
			status('running')
		},
		cancel(cause) { cancellations.push(cause); this.inbox.clear() },
		whenIdle() { return this.status === 'idle' ? Promise.resolve() : new Promise((resolve) => idleWaiters.push(resolve)) },
	}
	agent.inbox = new Inbox(session, Object.fromEntries(['inserted', 'claimed', 'discarded'].map((name) => [name, (message, turn) => emit(`agent/inbox/${name}`, { agent, message, turn })])))
	const registry = new Map([[agent.id, agent]])
	const ctx = {
		fiber: { state: 2 }, logger,
		agents: {
			get: (id) => registry.get(id), list: () => [...registry.values()],
			withoutInitiator(fn) {
				const promise = fn()
				runs.add(promise)
				promise.finally(() => runs.delete(promise))
				return promise
			},
		},
		on(name, listener) {
			if (!listeners.has(name)) listeners.set(name, new Set())
			listeners.get(name).add(listener)
			return () => listeners.get(name).delete(listener)
		},
		effect(factory) {
			const iterator = factory()
			effects.push({ iterator, ready: iterator.next() })
		},
	}
	function status(value) {
		if (agent.status === value) return
		agent.status = value
		emit('agent/status', { agent, status: value })
		if (value === 'idle') idleWaiters.splice(0).forEach((resolve) => resolve())
	}
	async function flush() {
		while (runs.size) await Promise.all([...runs])
		await Promise.resolve()
	}
	async function ready() { await Promise.all(effects.map((effect) => effect.ready)); await flush() }
	let disposed = false
	async function dispose() {
		if (disposed) return
		disposed = true
		ctx.fiber.state = 3
		for (const effect of effects) {
			const { value } = await effect.ready
			await value()
			await effect.iterator.return()
		}
		listeners.clear()
	}
	function claim() { return agent.inbox.claim('next-turn', 1) }
	async function preStep(messages, next = async () => ({ kind: 'enter', messages }), signal = new AbortController().signal) {
		const handlers = [...(listeners.get('agent/pre-step') ?? [])]
		const dispatch = (index) => index === handlers.length ? next() : handlers[index]({ agent, messages, signal, turn: 1, step: 1 }, () => dispatch(index + 1))
		return dispatch(0)
	}
	async function admit() {
		const messages = claim()
		const decision = await preStep(messages)
		assert.equal(decision.kind, 'enter')
		for (const message of decision.messages) session.append('user/message', message)
		return messages
	}
	async function finish(reason = { kind: 'completed' }) {
		session.append('turn/end', { reason })
		status('idle')
		await flush()
	}
	// `deferStart` reproduces the production order for a *fresh* `/loop`: the
	// driver is already installed when the loop is created. The default order
	// (start first) exercises the install-time catch-up pass instead.
	if (!deferStart) controller.start(session.id, 'Complete the regression work', maxRounds, intervalMs)
	for (const message of initialMessages) agent.inbox.append('next-turn', message)
	const driver = installLoopDriver(ctx, controller, restore, autoContinue === undefined ? {} : { autoContinue: () => autoContinue })
	// Production wires this in src/index.ts; tests opt in so the wakeup contract
	// is asserted explicitly rather than assumed.
	if (wireNotifier) controller.setNotifier((loop) => driver.nudge(loop.sessionId))
	t.after(async () => {
		// Disposal must join running owned work; explicitly converge the fake agent.
		const pending = dispose()
		status('idle')
		await pending
		assert.deepEqual(warnings, [])
	})
	if (!restore) await ready()
	return { agent, controller, session, queued, notices, human$1, cancellations, ctx, emit, ready, flush, status, claim, preStep, admit, finish, dispose, loop: () => controller.get(session.id) }
}

for (const phase of ['queued', 'claimed', 'admitted']) {
	test(`cancellation in ${phase} phase disarms without completing and does not restart`, async (t) => {
		const h = await harness(t)
		if (phase === 'claimed') h.claim()
		if (phase === 'admitted') await h.admit()
		h.agent.cancel({ kind: 'user' })
		await h.finish({ kind: 'aborted', cause: { kind: 'user' } })
		assert.equal(h.loop().phase, 'active')
		assert.equal(h.loop().armed, false)
		assert.equal(h.queued.length, 1)
		// The stop is announced, and the announcement names its cause. A round the
		// turn was aborted before ever claiming is reported as an abort; a claimed
		// or admitted round is reported as a cancelled round.
		assert.equal(h.notices.length, 1)
		assert.equal(h.loop().pausedReason.code, phase === 'queued' ? 'round-aborted' : 'round-cancelled')
		assert.match(h.notices[0].content[0].text, /<loop_paused>/)
		// An unrelated human turn does not implicitly restore automatic authority.
		h.agent.followup(human())
		await h.admit()
		await h.finish()
		assert.equal(h.queued.length, 1, 'no further round is queued')
		assert.equal(h.human$1.length, 1, 'the human turn is not a loop round')
		assert.equal(h.loop().armed, false)
	})
}

const continueOn = { enabled: true, maxContinuations: 2, onlyWhileLooping: true }
const isContinuation = (message) => /<output_limit_continue>/.test(message.content[0].text)
/** Run the pending continuation turn: a real agent goes running when it claims it. */
async function runPending(h, reason) {
	h.claim()
	h.status('running')
	await h.finish(reason)
}
/** End the test with no armed loop, so teardown has nothing left to announce. */
async function settle(h) {
	if (h.loop()?.phase === 'active') h.controller.cancel(h.session.id, 'test done')
	await h.flush()
}

test('max-tokens with auto-continue queues a continuation instead of pausing', async (t) => {
	const h = await harness(t, { autoContinue: continueOn })
	await h.admit()
	await h.finish({ kind: 'max-tokens' })
	assert.equal(h.loop().armed, true, 'the loop keeps running')
	assert.equal(h.loop().pausedReason, undefined)
	assert.equal(h.notices.length, 1)
	assert.ok(isContinuation(h.notices[0]))
	assert.match(h.notices[0].content[0].text, /1\/2/)
	// The continuation is pending turn input, so no round is queued on top of it
	// and the round budget is not spent.
	assert.equal(h.queued.length, 1)
	assert.equal(h.loop().roundsStarted, 1)
	await runPending(h, { kind: 'completed' })
	await settle(h)
})

test('a continuation that finishes normally lets the loop queue its next round', async (t) => {
	const h = await harness(t, { autoContinue: continueOn })
	await h.admit()
	await h.finish({ kind: 'max-tokens' })
	await runPending(h, { kind: 'completed' })
	assert.equal(h.loop().armed, true)
	assert.deepEqual(h.queued.map((message) => message.source.round), [1, 2], 'the next round follows the completed continuation')
	await settle(h)
})

test('the continuation streak resets once a turn ends normally', async (t) => {
	const h = await harness(t, { maxRounds: 5, autoContinue: continueOn })
	await h.admit()
	await h.finish({ kind: 'max-tokens' })
	await runPending(h, { kind: 'max-tokens' })
	await runPending(h, { kind: 'completed' })
	// Round 2 gets a fresh budget of two continuations.
	await h.admit()
	await h.finish({ kind: 'max-tokens' })
	assert.equal(h.loop().armed, true)
	assert.match(h.notices.filter(isContinuation).at(-1).content[0].text, /1\/2/)
	await runPending(h, { kind: 'completed' })
	await settle(h)
})

test('auto-continue gives up after the cap and pauses with a reason', async (t) => {
	const h = await harness(t, { autoContinue: continueOn })
	await h.admit()
	await h.finish({ kind: 'max-tokens' })
	await runPending(h, { kind: 'max-tokens' })
	await runPending(h, { kind: 'max-tokens' })
	assert.equal(h.notices.filter(isContinuation).length, 2)
	assert.equal(h.loop().armed, false)
	assert.equal(h.loop().pausedReason.code, 'max-tokens')
	assert.match(h.loop().pausedReason.message, /2 times in a row/)
	assert.match(h.notices.at(-1).content[0].text, /<loop_paused>/)
})

test('auto-continue switched off keeps the official stop-at-max-tokens contract', async (t) => {
	const h = await harness(t, { autoContinue: { ...continueOn, enabled: false } })
	await h.admit()
	await h.finish({ kind: 'max-tokens' })
	assert.equal(h.loop().armed, false)
	assert.equal(h.loop().pausedReason.code, 'max-tokens')
	assert.equal(h.notices.filter(isContinuation).length, 0)
})

test('auto-continue limited to loops leaves a non-looping session alone', async (t) => {
	const h = await harness(t, { autoContinue: continueOn })
	h.controller.cancel(h.session.id, 'not looping')
	await h.flush()
	h.agent.followup(human())
	await runPending(h, { kind: 'max-tokens' })
	assert.equal(h.notices.filter(isContinuation).length, 0)
})

test('auto-continue for every session continues a plain conversation too', async (t) => {
	const h = await harness(t, { autoContinue: { ...continueOn, onlyWhileLooping: false } })
	h.controller.cancel(h.session.id, 'not looping')
	await h.flush()
	h.agent.followup(human())
	await runPending(h, { kind: 'max-tokens' })
	assert.equal(h.notices.filter(isContinuation).length, 1)
	await runPending(h, { kind: 'completed' })
})

test('exact admitted-round budget blocks rather than scheduling an extra round', async (t) => {
	const h = await harness(t, { maxRounds: 2 })
	await h.admit()
	await h.finish()
	assert.deepEqual(h.queued.map((message) => message.source.round), [1, 2])
	await h.admit()
	await h.finish()
	assert.equal(h.loop().roundsStarted, 2)
	assert.equal(h.loop().phase, 'blocked')
	assert.equal(h.loop().armed, false)
	assert.equal(h.loop().blockedReason.code, 'round-limit')
	assert.equal(h.queued.length, 2)
})

test('max-token termination disarms an admitted round', async (t) => {
	const h = await harness(t)
	await h.admit()
	await h.finish({ kind: 'max-tokens' })
	assert.equal(h.loop().armed, false)
	assert.equal(h.queued.length, 1)
	// The reported failure mode: this stop used to be silent, so a human saw a
	// loop go quiet with no way to tell why.
	assert.equal(h.loop().pausedReason.code, 'max-tokens')
	assert.equal(h.notices.length, 1)
	assert.match(h.notices[0].content[0].text, /model output limit/)
})

test('queued competing human turn rejects loop and preserves claimed context order', async (t) => {
	const h = await harness(t)
	const context = [human('context one'), human('context two')]
	for (const message of context) h.agent.inbox.append('next-step', message)
	const competing = human()
	h.agent.followup(competing)
	const messages = h.claim()
	assert.equal((await h.preStep(messages)).kind, 'reject')
	assert.deepEqual(h.agent.inbox.nextStep, context)
	assert.deepEqual(h.agent.inbox.nextTurn, [competing])
	await h.flush()
	// The rejected round is not retried, and no second round is queued behind the
	// human's turn; the driver's only further message would be a stop notice.
	assert.equal(h.queued.length, 1)
	assert.equal(h.loop().roundsStarted, 0)
})

test('human turn arriving during awaited pre-step vetoes the claimed loop reservation', async (t) => {
	const h = await harness(t)
	const context = human('retain this context')
	h.agent.inbox.append('next-step', context)
	const messages = h.claim()
	const gate = deferred()
	const pending = h.preStep(messages, () => gate.promise)
	const competing = human()
	h.agent.followup(competing)
	gate.resolve({ kind: 'enter', messages })
	assert.equal((await pending).kind, 'reject')
	assert.deepEqual(h.agent.inbox.nextStep, [context])
	assert.deepEqual(h.agent.inbox.nextTurn, [competing])
	assert.equal(h.loop().roundsStarted, 0)
})

test('existing queued human input is respected when installing the driver', async (t) => {
	const competing = human()
	const h = await harness(t, { initialMessages: [competing] })
	assert.equal(h.queued.length, 0)
	assert.deepEqual(h.agent.inbox.nextTurn, [competing])
})

test('downstream rejection blocks the loop without consuming its round budget', async (t) => {
	const h = await harness(t)
	assert.equal((await h.preStep(h.claim(), async () => ({ kind: 'reject' }))).kind, 'reject')
	await h.finish()
	assert.equal(h.loop().blockedReason.code, 'prompt-rejected')
	assert.equal(h.loop().roundsStarted, 0)
	assert.equal(h.queued.length, 1)
})

test('dispose disarms, cancels owned activity, waits for idle, and removes listeners', async (t) => {
	const h = await harness(t)
	await h.admit()
	let settled = false
	const disposing = h.dispose().then(() => { settled = true })
	await Promise.resolve()
	await Promise.resolve()
	assert.equal(h.loop().armed, false)
	assert.deepEqual(h.cancellations, [{ kind: 'parent' }])
	assert.equal(settled, false)
	h.status('idle')
	await disposing
	h.controller.arm(h.session.id, true)
	h.status('running')
	h.status('idle')
	await h.flush()
	assert.equal(h.queued.length, 1)
})

test('dispose does not cancel unrelated human activity when no round is owned', async (t) => {
	const gate = deferred()
	const h = await harness(t, { restore: gate.promise })
	h.agent.followup(human())
	gate.resolve()
	await h.ready()
	await h.dispose()
	assert.equal(h.loop().armed, false)
	assert.deepEqual(h.cancellations, [])
	// Disposing announces the stop (a restart is a stop, not a decision), so the
	// human's own message is preserved alongside that one notice.
	assert.equal(h.agent.inbox.nextTurn.length, 2)
	assert.equal(h.notices.length, 1)
	assert.equal(h.loop().pausedReason.code, 'restart')
	assert.equal(h.agent.inbox.nextTurn.filter((message) => message.source?.kind !== 'plugin').length, 1)
})

test('cancellation while awaiting pre-step restores context and disarms at idle', async (t) => {
	const h = await harness(t)
	const context = human('context survives the admission fence')
	h.agent.inbox.append('next-step', context)
	const messages = h.claim()
	const gate = deferred()
	const abort = new AbortController()
	const pending = h.preStep(messages, () => gate.promise, abort.signal)
	abort.abort()
	gate.resolve({ kind: 'enter', messages })
	await pending
	assert.deepEqual(h.agent.inbox.nextStep, [context])
	await h.finish({ kind: 'aborted', cause: { kind: 'user' } })
	assert.equal(h.loop().armed, false)
	assert.equal(h.loop().roundsStarted, 0)
	assert.equal(h.queued.length, 1)
})

test('dispose during awaited pre-step prevents admission and joins the activity', async (t) => {
	const h = await harness(t)
	const messages = h.claim()
	const gate = deferred()
	const pending = h.preStep(messages, () => gate.promise)
	const disposing = h.dispose()
	await Promise.resolve()
	await Promise.resolve()
	gate.resolve({ kind: 'enter', messages })
	assert.equal((await pending).kind, 'reject')
	h.status('idle')
	await disposing
	assert.equal(h.loop().armed, false)
	assert.equal(h.loop().roundsStarted, 0)
	assert.equal(h.queued.length, 1)
})

test('restore barrier defers scheduling until restored state is ready', async (t) => {
	const gate = deferred()
	const h = await harness(t, { restore: gate.promise })
	assert.equal(h.queued.length, 0)
	gate.resolve()
	await h.ready()
	assert.equal(h.queued.length, 1)
})

// Claude Code's `/loop <interval> <prompt>` runs the prompt immediately and then
// repeats on that cadence, so pacing must delay only rounds after the first.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('a paced loop runs its first round at once, then holds the next until the interval', async (t) => {
	const h = await harness(t, { intervalMs: 80 })
	assert.equal(h.queued.length, 1, 'the first round is never delayed')
	await h.admit()
	await h.finish()
	// The next round must wait rather than queueing back to back.
	assert.equal(h.queued.length, 1, 'the second round is held back by the interval')
	await sleep(200)
	assert.equal(h.queued.length, 2, 'the second round is queued once the interval elapses')
	// `roundsStarted` only advances on admission, so assert the queued round itself.
	assert.equal(h.queued[1].source.round, 2)
	assert.equal(h.queued[1].source.loopId, h.loop().id)
})

test('an unpaced loop continues immediately after a round finishes', async (t) => {
	const h = await harness(t)
	assert.equal(h.queued.length, 1)
	await h.admit()
	await h.finish()
	assert.equal(h.queued.length, 2, 'no interval means no pacing')
})

test('disposal cancels a pending interval wakeup', async (t) => {
	const h = await harness(t, { intervalMs: 80 })
	await h.admit()
	await h.finish()
	assert.equal(h.queued.length, 1)
	await h.dispose()
	await sleep(200)
	assert.equal(h.queued.length, 1, 'a disposed driver never queues the held round')
})

test('pausing a paced loop during the wait prevents the held round', async (t) => {
	const h = await harness(t, { intervalMs: 80 })
	await h.admit()
	await h.finish()
	assert.equal(h.queued.length, 1)
	h.controller.arm(h.session.id, false)
	await sleep(200)
	assert.equal(h.queued.length, 1, 'a paused loop does not resume from a stale wakeup')
	assert.equal(h.loop().phase, 'active')
	assert.equal(h.loop().armed, false)
})

// --- change-sink wakeup ---------------------------------------------------
// Reported bug: `/loop <objective>` typed into an already-idle session created
// an armed loop whose first round never ran (`roundsStarted: 0`, observed in a
// real checkpoint). The driver wakes only on agent lifecycle events, and a
// slash command runs without a turn, so nothing ever nudged it. Claude Code's
// `/loop` states the contract plainly: run the prompt immediately, do not wait
// for the first scheduled fire.

test('starting a loop on an already-idle agent queues the first round at once', async (t) => {
	const h = await harness(t, { deferStart: true, wireNotifier: true })
	h.controller.start(h.session.id, 'Ship the fix', 3)
	await h.flush()
	assert.equal(h.queued.length, 1, 'the first round is queued without any status change')
	assert.equal(h.loop().roundsStarted, 0, 'queued, and admission is still the pre-step contract')
	assert.match(h.queued[0].content[0].text, /Ship the fix/)
	assert.equal(h.agent.status, 'running', 'followup started the agent')
})

test('without the change sink the same start stays dormant (the reported failure)', async (t) => {
	const h = await harness(t, { deferStart: true })
	h.controller.start(h.session.id, 'Ship the fix', 3)
	await h.flush()
	assert.equal(h.queued.length, 0, 'no sink means no wakeup: this is the bug being fixed')
	assert.equal(h.loop().armed, true, 'the loop is armed and looks healthy')
	assert.equal(h.loop().roundsStarted, 0, 'yet no round ever starts')
})

test('the controller notifies only for armed active loops', () => {
	const seen = []
	const controller = new LoopController(undefined, { info() {}, warn() {} })
	controller.setNotifier((loop) => seen.push(`${loop.phase}/${loop.armed}`))

	controller.start('sink-session', 'first', 3)
	assert.deepEqual(seen, ['active/true'], 'creating an armed loop wakes the driver')

	controller.arm('sink-session', false)
	assert.equal(seen.length, 1, 'pausing is silent')

	controller.arm('sink-session', true)
	assert.equal(seen.length, 2, 'resuming wakes the driver again')

	controller.editObjective('sink-session', 'second')
	assert.equal(seen.length, 3, 'editing re-reads live state in the driver')

	controller.complete('sink-session', 'done')
	assert.equal(seen.length, 3, 'terminal transitions never wake the driver')

	// Replacing a terminal loop does wake it again; cancelling that one does not.
	controller.start('sink-session', 'third', 3)
	assert.equal(seen.length, 4, 'a terminal loop is replaced by a waking start')
	controller.cancel('sink-session', 'nope')
	assert.equal(seen.length, 4, 'cancelling is silent')
})

test('a failing change sink never fails the mutation that caused it', () => {
	const warnings = []
	const controller = new LoopController(undefined, { info() {}, warn: (message) => warnings.push(message) })
	controller.setNotifier(() => {
		throw new Error('sink is down')
	})
	const loop = controller.start('sink-session', 'objective', 3)
	assert.equal(loop.armed, true, 'the loop is still created')
	assert.equal(controller.get('sink-session').objective, 'objective')
	assert.equal(warnings.length, 1)
	assert.match(warnings[0], /loop change notification failed/)
})

test('detaching the sink stops wakeups, so a disposed driver is never called', async (t) => {
	const h = await harness(t, { deferStart: true, wireNotifier: true })
	h.controller.setNotifier(undefined)
	h.controller.start(h.session.id, 'Ship the fix', 3)
	await h.flush()
	assert.equal(h.queued.length, 0, 'a detached sink is inert')
})

test('an armed loop that survived a restart resumes when its session starts', async (t) => {
	// A restart reads checkpoints straight into the registry, bypassing the
	// change notification, and the agent comes up after the driver installed —
	// so it also misses the install-time catch-up pass. Session start is the
	// remaining moment that can wake the restored loop.
	const h = await harness(t, { deferStart: true })
	h.controller.start(h.session.id, 'survive the restart', 3)
	await h.flush()
	assert.equal(h.queued.length, 0, 'a restore is not a change notification')

	h.emit('agent/session-start', { agent: h.agent })
	await h.flush()
	assert.equal(h.queued.length, 1, 'the resumed session wakes the driver')
	assert.match(h.queued[0].content[0].text, /survive the restart/)
	assert.equal(h.loop().armed, true)
})
