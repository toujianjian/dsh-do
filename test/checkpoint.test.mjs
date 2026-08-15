import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoopStore, serializeCheckpoint } from '../lib/types/checkpoint.js'
import { createLoop, markCompleted, markRoundAdmitted } from '../lib/types/loop.js'

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

test('serializeCheckpoint output is human-readable with a trailing newline', () => {
	const text = serializeCheckpoint(createLoop({ sessionId: 's', objective: 'o', maxRounds: 2, now: 1 }))
	assert.ok(text.endsWith('\n'))
	assert.ok(text.includes('"objective": "o"'))
	assert.ok(text.startsWith('{\n  "version": 1,'))
})
