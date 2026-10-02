import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyLoopProjection, loopStatusView, renderLoopStatusLine } from '../lib/types/loop-status.js'
import { armLoop, createLoop, markPaused, markRoundAdmitted, markCompleted } from '../lib/types/loop.js'

/**
 * The status surface a human reads. The failure this whole feature answers was
 * that a stopped loop was indistinguishable from a working one, so these tests
 * are about what a surface can say, not about internals.
 */

function loop(overrides = {}) {
	return { ...createLoop({ sessionId: 's1', objective: 'Finish the audit', maxRounds: 5 }), ...overrides }
}

test('a running loop reports progress and its cadence', () => {
	const view = loopStatusView(loop({ intervalMs: 600000, roundsStarted: 2 }))
	assert.equal(view.phase, 'active')
	assert.equal(view.armed, true)
	assert.equal(view.roundsStarted, 2)
	assert.equal(view.maxRounds, 5)
	assert.equal(view.pausedReason, undefined, 'a running loop has no pause to explain')
	assert.equal(renderLoopStatusLine(view), 'loop running · round 2/5 · every 600s')
})

test('a paused loop reports why it stopped instead of looking idle', () => {
	const paused = markPaused(armLoop(loop({ roundsStarted: 1 }), false), { code: 'max-tokens', message: 'the last round hit the model output limit' })
	const view = loopStatusView(paused)
	assert.equal(view.armed, false)
	assert.equal(view.pausedReason.code, 'max-tokens')
	assert.match(view.pausedReason.message, /output limit/)
	assert.match(renderLoopStatusLine(view), /^loop paused · round 1\/5 · the last round hit the model output limit$/)
})

test('a pause is not reported once the loop is armed again', () => {
	const paused = markPaused(armLoop(loop(), false), { code: 'restart', message: 'the harness shut down' })
	const resumed = armLoop(paused, true)
	assert.equal(resumed.pausedReason, undefined, 'resuming clears the stop it explains')
	assert.equal(loopStatusView(resumed).pausedReason, undefined)
})

test('a terminal loop reports its outcome rather than a pause', () => {
	const done = markCompleted(loop({ roundsStarted: 3 }), 'Audit finished')
	const view = loopStatusView(done)
	assert.equal(view.pausedReason, undefined)
	assert.equal(renderLoopStatusLine(view), 'loop completed · round 3/5 · Audit finished')
})

test('the status view is JSON-only, with no live objects leaking through', () => {
	const view = loopStatusView(loop({ roundsStarted: 1 }))
	assert.deepEqual(Object.keys(view).sort(), ['armed', 'loopId', 'maxRounds', 'objective', 'phase', 'roundsStarted'].sort())
	assert.doesNotThrow(() => JSON.parse(JSON.stringify(view)))
})

test('the projection folds admitted rounds from the durable log', () => {
	const round = (loopId, n) => ({ type: 'user/message', data: { source: { kind: 'loop', loopId, round: n } } })
	let state = applyLoopProjection(null, round('loop-a', 1))
	assert.deepEqual(state, { loopId: 'loop-a', roundsStarted: 1, lastRoundAt: null })
	state = applyLoopProjection(state, round('loop-a', 2))
	assert.equal(state.roundsStarted, 2)
	// Replay must be idempotent: the registry rebuilds a cell by folding from 0.
	assert.equal(applyLoopProjection(state, round('loop-a', 2)).roundsStarted, 2)
})

test('the projection ignores unrelated events and non-loop messages', () => {
	assert.equal(applyLoopProjection(null, { type: 'turn/end', data: {} }), null)
	assert.equal(applyLoopProjection(null, { type: 'user/message', data: { source: { kind: 'human' } } }), null)
})

test('replacing the loop restarts the fold instead of inflating progress', () => {
	const round = (loopId, n) => ({ type: 'user/message', data: { source: { kind: 'loop', loopId, round: n } } })
	const after = applyLoopProjection(applyLoopProjection(null, round('loop-a', 7)), round('loop-b', 1))
	assert.deepEqual(after, { loopId: 'loop-b', roundsStarted: 1, lastRoundAt: null })
})

test('a fresh loop carries no pause and reports round zero', () => {
	const view = loopStatusView(loop())
	assert.equal(view.roundsStarted, 0)
	assert.equal(view.pausedReason, undefined)
	assert.equal(markRoundAdmitted(loop(), 0).roundsStarted, 0)
})
