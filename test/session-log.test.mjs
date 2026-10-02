import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readSessionEvents } from '../lib/types/session-log.js'
import { admittedRounds } from '../lib/types/loop.js'

/**
 * `agent.session.events` was removed in DSH 0.1.5-rc.3, where the log is only
 * reachable through `session.snapshotEvents()`. dsh-do read the old getter in two
 * places, and on 0.1.5-rc.3 the failure was loud and visible in the TUI:
 *
 *     ❯ /loop 验证状态栏循环段
 *     ⚠ 命令执行失败: agent.session.events is not iterable
 *     ⏸ driver-failed · the loop driver failed: agent.session.events is not iterable
 *
 * Both call sites need the *whole* log, which is what the old getter returned —
 * not `ownEvents()`, which drops a fork-inherited prefix.
 */

function loopMessage(loopId, round) {
	return { type: 'user/message', data: { source: { kind: 'loop', loopId, round } } }
}

test('reads the log through snapshotEvents(), the 0.1.5-rc.3 accessor', () => {
	const events = [loopMessage('loop-1', 2)]
	assert.deepEqual(readSessionEvents({ snapshotEvents: () => events }), events)
})

test('falls back to the legacy events getter', () => {
	const events = [loopMessage('loop-1', 2)]
	assert.deepEqual(readSessionEvents({ events }), events)
})

test('a session with neither accessor yields an empty log instead of throwing', () => {
	// This is the shape that produced "is not iterable" in production.
	assert.deepEqual(readSessionEvents({}), [])
	assert.deepEqual(readSessionEvents(undefined), [])
	assert.deepEqual(readSessionEvents(null), [])
	assert.deepEqual(readSessionEvents(42), [])
	assert.deepEqual(readSessionEvents({ events: 'not-an-array', snapshotEvents: undefined }), [])
	assert.deepEqual(readSessionEvents({ snapshotEvents: () => 'not-an-array' }), [])
})

test('snapshotEvents() wins when both accessors exist, so newer lines never read a stale array', () => {
	const fresh = [loopMessage('loop-1', 5)]
	const stale = [loopMessage('loop-1', 1)]
	assert.deepEqual(readSessionEvents({ snapshotEvents: () => fresh, events: stale }), fresh)
})

test('round accounting works on the 0.1.5-rc.3 session shape', () => {
	const agent = { session: { snapshotEvents: () => [loopMessage('loop-1', 1), loopMessage('loop-1', 3), loopMessage('loop-1', 2)] } }
	assert.equal(admittedRounds(agent, 'loop-1'), 3, 'highest admitted round wins')
	assert.equal(admittedRounds(agent, 'loop-9'), 0, 'other loops do not contribute')
})

test('round accounting still works on the legacy session shape', () => {
	const agent = { session: { events: [loopMessage('loop-1', 4)] } }
	assert.equal(admittedRounds(agent, 'loop-1'), 4)
})

test('round accounting survives a session with no readable log', () => {
	assert.equal(admittedRounds({ session: {} }, 'loop-1'), 0)
	assert.equal(admittedRounds({ session: undefined }, 'loop-1'), 0)
})
