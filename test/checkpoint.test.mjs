import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoopStore, parseCheckpoint, serializeCheckpoint } from '../lib/types/checkpoint.js'
import { armLoop, createLoop, markCompleted, markPaused, markRoundAdmitted, MAX_TIMER_DELAY_MS } from '../lib/types/loop.js'

test('LoopStore persists and restores loops keyed by session id', async () => {
	const root = await mkdtemp(join(tmpdir(), 'dsh-do-'))
	try {
		const store = new LoopStore(root)
		const loop = createLoop({ sessionId: 'session-a', objective: 'do the thing', maxRounds: 4 })
		await store.write(loop)

		const loaded = await store.load()
		assert.equal(loaded.size, 1)
		assert.deepEqual(loaded.get('session-a'), loop)

		const onDisk = JSON.parse(await readFile(join(root, `loop-${loop.id}.json`), 'utf8'))
		assert.equal(onDisk.version, 1)
		assert.deepEqual(onDisk.loop, loop)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

// A paced loop must survive persistence: silently dropping `intervalMs` would
// turn it into an unpaced one that burns its whole round budget back to back.
test('a paced loop round-trips its interval through save and load', async () => {
	const root = await mkdtemp(join(tmpdir(), 'dsh-do-'))
	try {
		const store = new LoopStore(root)
		const loop = createLoop({ sessionId: 'session-paced', objective: 'watch the build', maxRounds: 5, intervalMs: 90_000 })
		assert.equal(loop.intervalMs, 90_000)
		await store.write(loop)
		const loaded = await store.load()
		assert.equal(loaded.get('session-paced').intervalMs, 90_000)
		const onDisk = JSON.parse(await readFile(join(root, `loop-${loop.id}.json`), 'utf8'))
		assert.equal(onDisk.loop.intervalMs, 90_000)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('an unpaced loop stays unpaced through persistence', async () => {
	const root = await mkdtemp(join(tmpdir(), 'dsh-do-'))
	try {
		const store = new LoopStore(root)
		const loop = createLoop({ sessionId: 'session-plain', objective: 'o', maxRounds: 2 })
		assert.equal(loop.intervalMs, undefined)
		await store.write(loop)
		const loaded = await store.load()
		assert.equal(loaded.get('session-plain').intervalMs, undefined)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

for (const [label, intervalMs] of [
	['a wrong type', '60000'],
	['zero', 0],
	['a negative value', -1],
	['a fractional value', 1500.5],
	['a non-finite value', Number.POSITIVE_INFINITY],
	// Beyond this the delay could never be scheduled, so it is corrupt, not paced.
	['a value past the timer ceiling', MAX_TIMER_DELAY_MS + 1],
]) {
	test(`a checkpoint with ${label} intervalMs is rejected rather than unpaced`, () => {
		const loop = createLoop({ sessionId: 'session-bad', objective: 'o', maxRounds: 2 })
		const parsed = parseCheckpoint(JSON.stringify({ version: 1, loop: { ...loop, intervalMs } }), 'loop-x.json')
		assert.equal(parsed.ok, false)
		assert.match(parsed.error, /invalid intervalMs/)
	})
}

test('the timer ceiling itself is an accepted interval', () => {
	const loop = createLoop({ sessionId: 'session-max', objective: 'o', maxRounds: 2 })
	const parsed = parseCheckpoint(JSON.stringify({ version: 1, loop: { ...loop, intervalMs: MAX_TIMER_DELAY_MS } }), 'loop-max.json')
	assert.equal(parsed.ok, true)
	assert.equal(parsed.loop.intervalMs, MAX_TIMER_DELAY_MS)
})

test('LoopStore last write wins atomically for one file', async () => {
	const root = await mkdtemp(join(tmpdir(), 'dsh-do-'))
	try {
		const store = new LoopStore(root)
		const base = createLoop({ sessionId: 'session-b', objective: 'o', maxRounds: 3, now: 1 })
		await store.write(markRoundAdmitted(base, 1, 2))
		await store.write(markRoundAdmitted(base, 2, 3))
		const loaded = await store.load()
		assert.equal(loaded.get('session-b').roundsStarted, 2)
		assert.equal(loaded.get('session-b').updatedAt, 3)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('LoopStore ignores unrelated and malformed files, reports errors', async () => {
	const root = await mkdtemp(join(tmpdir(), 'dsh-do-'))
	try {
		const { writeFile } = await import('node:fs/promises')
		await writeFile(join(root, 'unrelated.txt'), 'x')
		await writeFile(join(root, 'loop-bad.json'), 'not json')
		const errors = []
		const store = new LoopStore(root, { onError: (message) => errors.push(message) })
		const loaded = await store.load()
		assert.equal(loaded.size, 0)
		assert.ok(errors.some((message) => message.includes('loop-bad.json')))
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('LoopStore keeps the newest record per session across loop replacements', async () => {
	const root = await mkdtemp(join(tmpdir(), 'dsh-do-'))
	try {
		const store = new LoopStore(root)
		const first = createLoop({ sessionId: 'session-c', objective: 'old', maxRounds: 2, now: 1 })
		const second = markCompleted(createLoop({ sessionId: 'session-c', objective: 'new', maxRounds: 3, now: 2 }), 'replaced', 3)
		// first is terminal, second is newer; a fresh store must restore the newer record
		await store.write(first)
		await store.write(second)
		const loaded = await store.load()
		assert.equal(loaded.size, 1)
		assert.equal(loaded.get('session-c').objective, 'new')
		assert.equal(loaded.get('session-c').updatedAt, 3)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

// A damaged record must never cost another session its loop. `version` is the
// one field whose diagnostic coerced the parsed value with `String()`, so
// `{"toString": null}` threw a TypeError *out of* the tolerant parser and out of
// `LoopStore.load()`, which silently discarded every healthy checkpoint.
test('a checkpoint whose version cannot be stringified is skipped, not thrown', async () => {
	const root = await mkdtemp(join(tmpdir(), 'dsh-do-'))
	try {
		const { writeFile } = await import('node:fs/promises')
		const healthy = createLoop({ sessionId: 'healthy', objective: 'keep working', maxRounds: 2 })
		const errors = []
		const store = new LoopStore(root, { onError: (message) => errors.push(message) })
		await store.write(healthy)
		await writeFile(join(root, 'loop-poison.json'), '{"version":{"toString":null},"loop":{}}')
		const loaded = await store.load()
		assert.deepEqual([...loaded.keys()], ['healthy'])
		assert.equal(errors.length, 1)
		assert.match(errors[0], /loop-poison\.json/)
		// The diagnostic itself is safe to render.
		assert.doesNotMatch(errors[0], /\[object/)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('checkpoint diagnostics describe hostile scalars without coercing them', () => {
	// An own non-callable `toString` is what makes `String(value)` throw
	// ("Cannot convert object to primitive value"); an accessor named
	// `toString` would not, because the property name differs.
	for (const [label, document, pattern] of [
		['a poisoned version', '{"version":{"toString":null},"loop":{}}', /unsupported version an object/],
		['a numeric-toString version', '{"version":{"toString":7},"loop":{}}', /unsupported version an object/],
		['an array version', '{"version":[1],"loop":{}}', /unsupported version an array/],
		['a string version', '{"version":"1","loop":{}}', /unsupported version "1"/],
		['a poisoned phase', '{"version":1,"loop":{"id":"ok","sessionId":"s","objective":"o","maxRounds":1,"phase":{"toString":null},"armed":true,"roundsStarted":0,"startedAt":0,"updatedAt":0}}', /invalid phase/],
		['a poisoned terminal phase', '{"version":1,"loop":{"id":"ok","sessionId":"s","objective":"o","maxRounds":1,"phase":{"toString":null},"armed":true,"roundsStarted":0,"startedAt":0,"updatedAt":0}}', /invalid phase/],
	]) {
		// Returning a rejection (instead of throwing) is the contract.
		const result = parseCheckpoint(document, 'loop-test.json')
		assert.equal(result.ok, false, label)
		assert.match(result.ok ? '' : result.error, pattern, label)
	}
	// A pause recorded on a non-active, non-string phase is reported by value
	// kind: `phase` is validated first, so this documents that ordering.
	const armedTerminal = '{"version":1,"loop":{"id":"ok","sessionId":"s","objective":"o","maxRounds":1,"phase":"completed","armed":true,"roundsStarted":0,"startedAt":0,"updatedAt":0}}'
	assert.match(parseCheckpoint(armedTerminal, 'loop-test.json').error ?? '', /armed "completed" phase/)
})

// Restore runs before the loop tools are registered, so a checkpoint directory
// entry that blocks on read (a FIFO with no writer) would freeze plugin startup
// forever. Only regular files may be opened.
test('LoopStore ignores non-regular files instead of blocking on them', async () => {
	const root = await mkdtemp(join(tmpdir(), 'dsh-do-'))
	try {
		const { mkdir, writeFile, symlink } = await import('node:fs/promises')
		const { execFile } = await import('node:child_process')
		const { promisify } = await import('node:util')
		const healthy = createLoop({ sessionId: 'healthy', objective: 'keep', maxRounds: 2 })
		const errors = []
		const store = new LoopStore(root, { onError: (message) => errors.push(message) })
		await store.write(healthy)
		// A directory, a symlink to a valid document elsewhere, and — where the
		// platform has one — a FIFO: none of these is a checkpoint this store wrote.
		await mkdir(join(root, 'loop-directory.json'))
		await writeFile(join(root, 'elsewhere.json'), serializeCheckpoint({ ...healthy, sessionId: 'elsewhere' }))
		// Creating a symlink needs a privilege Windows may withhold; skip it there
		// rather than fail a correct implementation.
		const linked = await symlink(join(root, 'elsewhere.json'), join(root, 'loop-symlink.json')).then(
			() => true,
			() => false,
		)
		const fifo = join(root, 'loop-fifo.json')
		const madeFifo = await promisify(execFile)('mkfifo', [fifo]).then(
			() => true,
			() => false,
		)
		// A hang here is the failure mode, so the assertion is the wait itself.
		const loaded = await Promise.race([
			store.load(),
			new Promise((resolve) => setTimeout(() => resolve('timeout'), 5_000)),
		])
		assert.notEqual(loaded, 'timeout', 'load() must not block on a non-regular checkpoint entry')
		assert.deepEqual([...loaded.keys()], ['healthy'])
		assert.ok(errors.some((message) => message.includes('loop-directory.json')))
		if (linked) assert.ok(errors.some((message) => message.includes('loop-symlink.json')))
		if (madeFifo) assert.ok(errors.some((message) => message.includes('loop-fifo.json')))
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('malformed blockedReason cannot interrupt recovery of healthy checkpoints', async () => {
	const root = await mkdtemp(join(tmpdir(), 'dsh-do-'))
	try {
		const { writeFile } = await import('node:fs/promises')
		const healthy = createLoop({ sessionId: 'healthy', objective: 'keep', maxRounds: 2 })
		const errors = []
		const store = new LoopStore(root, { onError: message => errors.push(message) })
		await store.write(healthy)
		await writeFile(join(root, 'loop-corrupt.json'), serializeCheckpoint({ ...healthy, sessionId: 'bad', blockedReason: null }))
		assert.deepEqual([...(await store.load()).keys()], ['healthy'])
		assert.equal(errors.length, 1)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('checkpoint parser rejects unsafe identifiers and nonfinite timestamps', () => {
	const base = createLoop({ sessionId: 's', objective: 'o', maxRounds: 2 })
	for (const id of ['../escape', 'x/../../escape', 'x\\escape', '']) {
		assert.equal(parseCheckpoint(serializeCheckpoint({ ...base, id }), 'loop-test.json').ok, false)
	}
	const text = serializeCheckpoint(base).replace(String(base.startedAt), '1e400')
	assert.equal(parseCheckpoint(text, 'loop-test.json').ok, false)
})

test('serializeCheckpoint output is human-readable with a trailing newline', () => {
	const text = serializeCheckpoint(createLoop({ sessionId: 's', objective: 'o', maxRounds: 2, now: 1 }))
	assert.ok(text.endsWith('\n'))
	assert.ok(text.includes('"objective": "o"'))
	assert.ok(text.startsWith('{\n  "version": 1,'))
})

// A wrong-typed optional payload used to be accepted and then silently dropped,
// so a damaged record reported a loop whose summary/reason had vanished with no
// diagnostic at all. Rejecting it turns silent data loss into a reported skip.
test('a recorded pause round-trips, and a corrupt one is rejected', () => {
	const paused = markPaused(armLoop(createLoop({ sessionId: 's', objective: 'o', maxRounds: 2, now: 5 }), false), { code: 'max-tokens', message: 'output limit' }, 42)
	const parsed = parseCheckpoint(serializeCheckpoint(paused), 'loop-paused.json')
	assert.equal(parsed.ok, true)
	assert.equal(parsed.ok ? parsed.loop.pausedReason?.code : undefined, 'max-tokens')
	assert.equal(parsed.ok ? parsed.loop.pausedReason?.at : undefined, 42)

	const base = createLoop({ sessionId: 's', objective: 'o', maxRounds: 2 })
	for (const bad of [
		{ ...base, armed: false, pausedReason: { code: 'not-a-cause', message: 'x', at: 1 } },
		{ ...base, armed: false, pausedReason: { code: 'max-tokens', message: 7, at: 1 } },
		{ ...base, armed: false, pausedReason: { code: 'max-tokens', message: 'x', at: 'soon' } },
		{ ...base, armed: false, pausedReason: 'max-tokens' },
		// A pause only describes an active, disarmed loop; the other combinations
		// are contradictions that would make a status surface report nonsense.
		{ ...base, armed: true, pausedReason: { code: 'max-tokens', message: 'x', at: 1 } },
		{ ...base, phase: 'completed', armed: false, pausedReason: { code: 'max-tokens', message: 'x', at: 1 } },
	]) {
		const result = parseCheckpoint(serializeCheckpoint(bad), 'loop-bad.json')
		assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(bad.pausedReason)}`)
	}
})

test('checkpoint parser rejects wrong-typed summary and cancellation payloads', () => {
	const base = createLoop({ sessionId: 's', objective: 'o', maxRounds: 2 })
	for (const bad of [
		{ ...base, completedSummary: { note: 'object' } },
		{ ...base, completedSummary: 7 },
		{ ...base, completedSummary: null },
		{ ...base, cancelledReason: 12345 },
		{ ...base, cancelledReason: ['array'] },
	]) {
		const result = parseCheckpoint(serializeCheckpoint(bad), 'loop-test.json')
		assert.equal(result.ok, false)
		assert.match(result.ok ? '' : result.error, /completedSummary|cancelledReason/)
	}
	// Correctly typed payloads still round-trip.
	const good = { ...base, completedSummary: 'done', cancelledReason: 'stopped' }
	const parsed = parseCheckpoint(serializeCheckpoint(good), 'loop-test.json')
	assert.equal(parsed.ok, true)
	assert.equal(parsed.ok ? parsed.loop.completedSummary : undefined, 'done')
	assert.equal(parsed.ok ? parsed.loop.cancelledReason : undefined, 'stopped')
})

// `armed` is automatic-continuation authority that every terminal transition
// revokes. Accepting an armed terminal record would let loop_status report an
// armed completed loop and mislead the model's next decision.
test('checkpoint parser rejects an armed terminal phase', () => {
	const base = createLoop({ sessionId: 's', objective: 'o', maxRounds: 2 })
	for (const phase of ['completed', 'blocked', 'cancelled']) {
		assert.equal(parseCheckpoint(serializeCheckpoint({ ...base, phase, armed: true }), 'loop-test.json').ok, false)
		// A terminal record that correctly disarmed itself still restores.
		assert.equal(parseCheckpoint(serializeCheckpoint({ ...base, phase, armed: false }), 'loop-test.json').ok, true)
	}
	// An active loop keeps its arm state either way.
	assert.equal(parseCheckpoint(serializeCheckpoint({ ...base, phase: 'active', armed: true }), 'loop-test.json').ok, true)
})
