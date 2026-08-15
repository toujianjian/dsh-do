import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
	armLoop,
	createLoop,
	effectiveRounds,
	isLoopSource,
	markBlocked,
	markCancelled,
	markCompleted,
	markRoundAdmitted,
} from '../lib/loop.js'
import { renderLoopRoundPrompt, renderLoopWrapupContext } from '../lib/prompt.js'
import { parseCheckpoint, serializeCheckpoint } from '../lib/checkpoint.js'

test('createLoop mints an armed, active loop with the given budget', () => {
	const loop = createLoop({ sessionId: 'session-1', objective: 'Fix the build', maxRounds: 3, now: 1000 })
	assert.equal(loop.phase, 'active')
	assert.equal(loop.armed, true)
	assert.equal(loop.roundsStarted, 0)
	assert.equal(loop.objective, 'Fix the build')
	assert.equal(loop.maxRounds, 3)
	assert.equal(loop.startedAt, 1000)
	assert.equal(loop.updatedAt, 1000)
	assert.match(loop.id, /^loop-[0-9a-f-]+$/)
})

test('markRoundAdmitted only bumps higher rounds and touches updatedAt', () => {
	const base = createLoop({ sessionId: 's', objective: 'o', maxRounds: 5, now: 1 })
	const first = markRoundAdmitted(base, 1, 2)
	assert.equal(first.roundsStarted, 1)
	assert.equal(first.updatedAt, 2)
	const same = markRoundAdmitted(first, 1, 3)
	assert.equal(same, first)
	const lower = markRoundAdmitted(first, 0, 3)
	assert.equal(lower, first)
})

test('terminal transitions disarm the loop and carry their payload', () => {
	const base = createLoop({ sessionId: 's', objective: 'o', maxRounds: 2, now: 1 })
	const done = markCompleted(base, 'all green', 2)
	assert.equal(done.phase, 'completed')
	assert.equal(done.armed, false)
	assert.equal(done.completedSummary, 'all green')

	const blocked = markBlocked(base, { code: 'round-limit', message: 'budget exhausted' }, 3)
	assert.equal(blocked.phase, 'blocked')
	assert.equal(blocked.armed, false)
	assert.deepEqual(blocked.blockedReason, { code: 'round-limit', message: 'budget exhausted' })

	const cancelled = markCancelled(base, 'stuck', 4)
	assert.equal(cancelled.phase, 'cancelled')
	assert.equal(cancelled.armed, false)
	assert.equal(cancelled.cancelledReason, 'stuck')
})

test('armLoop toggles without touching phase', () => {
	const base = createLoop({ sessionId: 's', objective: 'o', maxRounds: 2, now: 1 })
	const disarmed = armLoop(base, false, 2)
	assert.equal(disarmed.armed, false)
	assert.equal(disarmed.phase, 'active')
	const rearmed = armLoop(disarmed, true, 3)
	assert.equal(rearmed.armed, true)
	assert.equal(armLoop(rearmed, true, 4), rearmed)
})

test('effectiveRounds falls back to the checkpoint hint without a live agent', () => {
	const loop = createLoop({ sessionId: 's', objective: 'o', maxRounds: 4, now: 1 })
	assert.equal(effectiveRounds(undefined, loop), 0)
	assert.equal(effectiveRounds(undefined, markRoundAdmitted(loop, 2)), 2)
})

test('isLoopSource narrows loop sources only', () => {
	assert.equal(isLoopSource({ kind: 'loop', loopId: 'l', round: 1 }), true)
	assert.equal(isLoopSource({ kind: 'user' }), false)
	assert.equal(isLoopSource({ kind: 'plugin', plugin: 'x' }), false)
	assert.equal(isLoopSource(undefined), false)
	assert.equal(isLoopSource(null), false)
	assert.equal(isLoopSource('loop'), false)
})

test('renderLoopRoundPrompt produces one text block with objective and budget', () => {
	const [block] = renderLoopRoundPrompt('Ship it', 2, 5)
	assert.equal(block.type, 'text')
	assert.ok(block.text.includes('Objective: "Ship it"'))
	assert.ok(block.text.includes('Round: 2/5'))
	assert.ok(block.text.includes('loop_done'))
	assert.ok(block.text.includes('loop_cancel'))
})

test('renderLoopWrapupContext renders completed and cancelled closings', () => {
	const [done] = renderLoopWrapupContext('Ship it', { kind: 'completed', summary: 'done' })
	assert.ok(done.text.includes('<loop_complete>'))
	assert.ok(done.text.includes('Summary: "done"'))
	const [cancelled] = renderLoopWrapupContext('Ship it', { kind: 'cancelled', reason: 'blocked on review' })
	assert.ok(cancelled.text.includes('<loop_cancelled>'))
	assert.ok(cancelled.text.includes('Reason: "blocked on review"'))
})

test('checkpoint serialize/parse round-trips a loop', () => {
	const loop = markBlocked(createLoop({ sessionId: 's', objective: 'o', maxRounds: 3, now: 1 }), { code: 'round-limit', message: 'limit' }, 2)
	const parsed = parseCheckpoint(serializeCheckpoint(loop), 'loop-x.json')
	assert.equal(parsed.ok, true)
	if (parsed.ok) assert.deepEqual(parsed.loop, loop)
})

test('parseCheckpoint tolerates malformed and foreign files', () => {
	assert.equal(parseCheckpoint('not json', 'a.json').ok, false)
	assert.equal(parseCheckpoint('{"version": 2, "loop": {}}', 'a.json').ok, false)
	assert.equal(parseCheckpoint('{"version": 1, "loop": {"id": 1}}', 'a.json').ok, false)
	assert.equal(parseCheckpoint(JSON.stringify({ version: 1, loop: { id: 'l', sessionId: 's', objective: 'o', maxRounds: 1, phase: 'active', armed: true, roundsStarted: 0, startedAt: 1, updatedAt: 1 } }), 'a.json').ok, true)
})
