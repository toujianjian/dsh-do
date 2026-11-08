/**
 * Repro: one poisoned checkpoint file aborts the whole restore.
 *
 * `parseCheckpoint` is documented as a tolerant parse, but its diagnostics call
 * `String()` on JSON-supplied values. A value whose primitive coercion throws
 * turns that diagnostic into an exception, which escapes `LoopStore.load()`
 * and takes every unrelated checkpoint down with it.
 */
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoopStore, parseCheckpoint, serializeCheckpoint } from './lib/types/checkpoint.js'
import { createLoop } from './lib/types/loop.js'

const root = await mkdtemp(join(tmpdir(), 'brute-poison-'))
const valid = serializeCheckpoint(createLoop({ sessionId: 'session-healthy', objective: 'keep working', maxRounds: 5 }))
await writeFile(join(root, 'loop-healthy.json'), valid)

const store = new LoopStore(root, { onError: (message) => console.log('onError:', message) })

// 1) The parser itself, on the two fields whose diagnostics stringify input.
for (const [label, text] of [
	['version', '{"version":{"toString":null},"loop":{}}'],
	['phase', '{"version":1,"loop":{"id":"ok","sessionId":"s","objective":"o","maxRounds":1,"phase":{"toString":null},"armed":true,"roundsStarted":0,"startedAt":0,"updatedAt":0}}'],
]) {
	try {
		const result = parseCheckpoint(text, 'loop-poison.json')
		console.log(`parse(${label}): returned ${JSON.stringify(result).slice(0, 80)}`)
	} catch (error) {
		console.log(`parse(${label}): THREW ${error.name}: ${error.message}`)
	}
}

// 2) The restore path: one poisoned file next to a healthy one.
await writeFile(join(root, 'loop-poison.json'), '{"version":{"toString":null},"loop":{}}')
try {
	const loops = await store.load()
	console.log(`load(): returned ${loops.size} loop(s): ${[...loops.keys()].join(',')}`)
} catch (error) {
	console.log(`load(): THREW ${error.name}: ${error.message} -> restore loses ALL ${(await readdir(root)).filter((n) => n.endsWith('.json')).length} checkpoint files`)
}

// 3) Control: same store, poisoned file removed.
await rm(join(root, 'loop-poison.json'))
const loops = await store.load()
console.log(`load() without the poisoned file: ${loops.size} loop(s): ${[...loops.keys()].join(',')}`)
await rm(root, { recursive: true, force: true })
