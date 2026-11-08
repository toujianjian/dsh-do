/**
 * Tier 1b: checkpoint store under filesystem chaos.
 *
 * The store is the only thing that survives a crash, so the invariants are
 * about the bytes on disk: a target file is always either the old document or
 * the new one, a rejected write leaves nothing behind, and restoring a hostile
 * directory never hangs or blows up.
 */
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, chmod, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import * as checkpoint from './lib/types/checkpoint.js'
import * as loop from './lib/types/loop.js'

const failures = []
const observations = []
const area = (name, fn) => {
	try {
		return fn()
	} catch (error) {
		failures.push({ area: name, label: 'sync', error: String(error) })
	}
}
const fail = (name, label, error) => failures.push({ area: name, label, error: error instanceof Error ? `${error.message}` : String(error) })
const note = (text) => observations.push(text)

async function withRoot(name, fn) {
	const root = await mkdtemp(join(tmpdir(), `brute-${name}-`))
	try {
		return await fn(root)
	} finally {
		await rm(root, { recursive: true, force: true }).catch(() => undefined)
	}
}

const makeLoop = (sessionId, overrides = {}) => loop.createLoop({ sessionId, objective: 'objective', maxRounds: 5, ...overrides })
const stateAt = (base, updatedAt) => ({ ...base, updatedAt })
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))
const tmpLeftovers = async (root) => (await readdir(root)).filter((name) => name.endsWith('.tmp'))

// ---------------------------------------------------------------- concurrency
await withRoot('concurrency', async (root) => {
	const store = new checkpoint.LoopStore(root)
	const ids = Array.from({ length: 12 }, (_, i) => `loop-${i}`)
	const bases = Object.fromEntries(ids.map((id) => [id, makeLoop(`session-${id}`)]))
	const writes = []
	for (let round = 0; round < 60; round++) {
		for (const id of ids) writes.push(store.write(stateAt({ ...bases[id], id }, 1_000 + round)))
	}
	await Promise.all(writes)
	const loaded = await store.load()
	if (loaded.size !== ids.length) fail('store.concurrency', 'loop count', `expected ${ids.length} loops, got ${loaded.size}`)
	for (const id of ids) {
		const path = join(root, `loop-${id}.json`)
		try {
			const doc = await readJson(path)
			if (doc.loop.id !== id) fail('store.concurrency', `file ${id}`, `wrong id ${doc.loop.id}`)
			if (doc.loop.updatedAt !== 1_059) fail('store.concurrency', `file ${id}`, `lost last write: updatedAt=${doc.loop.updatedAt}`)
		} catch (error) {
			fail('store.concurrency', `file ${id}`, error)
		}
	}
	const leftovers = await tmpLeftovers(root)
	if (leftovers.length > 0) fail('store.concurrency', 'tmp litter', `${leftovers.length} temp files left behind`)
})

// A rejected write must not poison the chain forever.
await withRoot('chain-recovery', async (root) => {
	const store = new checkpoint.LoopStore(root)
	const good = makeLoop('session-recover')
	const blocked = join(root, 'blocked')
	await writeFile(blocked, 'i am a file')
	const broken = new checkpoint.LoopStore(blocked)
	let rejected = false
	try {
		await broken.write(good)
	} catch {
		rejected = true
	}
	if (!rejected) fail('store.recovery', 'unwritable root', 'write to a file-as-root resolved instead of rejecting')
	await store.write(good)
	const loaded = await store.load()
	if (!loaded.has('session-recover')) fail('store.recovery', 'write after reject', 'store stopped accepting writes after a rejection')
})

// ---------------------------------------------------------------- volume
await withRoot('volume', async (root) => {
	const store = new checkpoint.LoopStore(root)
	const count = 4000
	const started = Date.now()
	const queue = []
	for (let i = 0; i < count; i++) {
		queue.push(store.write(makeLoop(`session-${i}`, { maxRounds: 3 })))
		if (queue.length >= 200) {
			await Promise.all(queue.splice(0))
		}
	}
	await Promise.all(queue)
	const writeMs = Date.now() - started
	const loadStart = Date.now()
	const loaded = await store.load()
	const loadMs = Date.now() - loadStart
	const files = (await readdir(root)).length
	note(`volume: ${count} loops, write=${writeMs}ms, load=${loadMs}ms, files=${files}, heap=${Math.round(process.memoryUsage().heapUsed / 1048576)}MB`)
	if (loaded.size !== count) fail('store.volume', 'load count', `expected ${count}, got ${loaded.size}`)
	if (files !== count) fail('store.volume', 'file count', `expected ${count}, got ${files}`)
})

// ---------------------------------------------------------------- huge payload
await withRoot('huge', async (root) => {
	const store = new checkpoint.LoopStore(root)
	const big = makeLoop('session-big', { objective: '\u5965'.repeat(4_000_000) })
	const started = Date.now()
	await store.write(big)
	const writeMs = Date.now() - started
	const loaded = await store.load()
	const state = loaded.get('session-big')
	note(`huge: 4M-char objective × 3 bytes, write=${writeMs}ms, roundtrip=${state?.objective.length ?? 0}`)
	if (state?.objective.length !== 4_000_000) fail('store.huge', 'objective', `lost content: ${state?.objective.length}`)
})

// ---------------------------------------------------------------- hostile directory layout
await withRoot('layout', async (root) => {
	const store = new checkpoint.LoopStore(root, { onError: (m) => note(`onError: ${m}`) })
	const valid = checkpoint.serializeCheckpoint(makeLoop('session-valid'))
	await writeFile(join(root, 'loop-good.json'), valid)
	await writeFile(join(root, 'loop-truncated.json'), valid.slice(0, valid.length - 20))
	await writeFile(join(root, 'loop-empty.json'), '')
	await writeFile(join(root, 'loop-binary.json'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0xff, 0xfe]))
	await writeFile(join(root, 'loop-nan.json'), '{"version":1,"loop":{"id":"x","sessionId":"s","objective":"o","maxRounds":1,"phase":"active","armed":true,"roundsStarted":0,"startedAt":NaN,"updatedAt":0}}')
	await mkdir(join(root, 'loop-directory.json'))
	await writeFile(join(root, 'not-a-loop.json'), valid)
	// A symlink to a valid document outside the store must not be accepted as
	// this store's own record, and must never be followed by a write.
	const outside = join(root, '..', `outside-${process.pid}.json`)
	await writeFile(outside, valid)
	await symlink(outside, join(root, 'loop-symlink.json'))
	const loaded = await store.load()
	note(`layout: loaded ${loaded.size} loop(s)`)
	for (const [sessionId, state] of loaded) {
		if (sessionId !== 'session-valid') note(`layout accepted a surprising record: ${sessionId}`)
		if (state.objective.length > 1000) note('layout: huge objective accepted')
	}
	// The write path must replace the symlink itself, never the target file.
	await store.write({ ...makeLoop('session-symlink'), id: 'symlink' })
	const outsideAfter = await readFile(outside, 'utf8')
	if (!outsideAfter.includes('objective')) fail('store.layout', 'symlink write', 'write followed the symlink and clobbered the outside file')
	const entries = await readdir(root)
	const stray = entries.filter((name) => name.startsWith('.') && name.endsWith('.tmp'))
	if (stray.length > 0) fail('store.layout', 'tmp litter', `${stray.length} temp file(s)`)
	await rm(outside, { force: true })
})

// Root that is a regular file: load must fail loudly, not silently "no loops".
await withRoot('root-is-file', async (root) => {
	const fileRoot = join(root, 'root-file')
	await writeFile(fileRoot, 'x')
	const store = new checkpoint.LoopStore(fileRoot)
	let threw = false
	try {
		await store.load()
	} catch (error) {
		threw = true
		note(`root-is-file: load throws ${error.code ?? error.message}`)
	}
	if (!threw) note('root-is-file: load returned silently (potential masked misconfiguration)')
})

// ---------------------------------------------------------------- a FIFO must not hang restore
await withRoot('fifo', async (root) => {
	const mkfifoCmd = spawn('mkfifo', [join(root, 'loop-fifo.json')])
	await new Promise((resolve) => mkfifoCmd.on('exit', resolve))
	const child = spawn(process.execPath, ['--input-type=module','-e', `
		import { LoopStore } from '${new URL('./lib/types/checkpoint.js', import.meta.url).pathname}'
		const store = new LoopStore(${JSON.stringify(root)}, { onError: (m) => console.log('ERR', m) })
		const loops = await store.load()
		console.log('LOADED', loops.size)
	`], { stdio: ['ignore', 'pipe', 'pipe'] })
	let out = ''
	child.stdout.on('data', (d) => (out += d))
	child.stderr.on('data', (d) => (out += d))
	const exitCode = await Promise.race([
		new Promise((resolve) => child.on('exit', (code, signal) => resolve(code ?? signal))),
		new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000)),
	])
	if (exitCode === 'timeout') {
		child.kill('SIGKILL')
		fail('store.fifo', 'restore hang', 'load() blocks forever on a FIFO named loop-*.json (would freeze plugin startup)')
	} else {
		note(`fifo: exited ${exitCode}: ${out.trim().slice(0, 200)}`)
	}
})

// ---------------------------------------------------------------- kill -9 during writes
await withRoot('kill', async (root) => {
	const target = join(root, 'loop-kill.json')
	const child = `
		import { LoopStore } from '${new URL('./lib/types/checkpoint.js', import.meta.url).pathname}'
		import { createLoop } from '${new URL('./lib/types/loop.js', import.meta.url).pathname}'
		const store = new LoopStore(${JSON.stringify(root)})
		let n = 0
		const base = createLoop({ sessionId: 'session-kill', objective: 'objective', maxRounds: 5 })
		for (;;) { n++; await store.write({ ...base, id: 'kill', updatedAt: n }) }
	`
	let crashes = 0
	const leftoverCounts = []
	const parentStore = new checkpoint.LoopStore(root)
	const seed = { ...makeLoop('session-kill'), id: 'kill', updatedAt: 0 }
	for (let attempt = 0; attempt < 40; attempt++) {
		await rm(target, { force: true })
		// Seed a valid document first: a kill before the child's first rename
		// would otherwise look like corruption when it is simply "no write yet".
		await parentStore.write(seed)
		const proc = spawn(process.execPath, ['--input-type=module','-e', child], { stdio: 'ignore' })
		await new Promise((resolve) => setTimeout(resolve, 20 + Math.floor(Math.random() * 120)))
		proc.kill('SIGKILL')
		await new Promise((resolve) => proc.on('exit', resolve))
		const store = new checkpoint.LoopStore(root)
		const loaded = await store.load()
		const state = loaded.get('session-kill')
		if (state === undefined) crashes++
		else if (state.objective !== 'objective' || state.id !== 'kill') crashes++
		const leftovers = await tmpLeftovers(root)
		leftoverCounts.push(leftovers.length)
		for (const name of leftovers) await rm(join(root, name), { force: true })
	}
	note(`kill: ${crashes} unreadable/invalid final documents out of 40 SIGKILLs; tmp leftovers per run max=${Math.max(...leftoverCounts)}`)
	if (crashes > 0) fail('store.kill', 'atomicity', `${crashes}/40 SIGKILL runs left an unreadable checkpoint`)
})

// ---------------------------------------------------------------- load racing writes
await withRoot('race', async (root) => {
	const store = new checkpoint.LoopStore(root)
	const base = makeLoop('session-race')
	let writing = true
	const writer = (async () => {
		let n = 0
		while (writing) {
			await store.write({ ...base, updatedAt: ++n })
		}
	})()
	let bad = 0
	for (let i = 0; i < 400; i++) {
		const loaded = await store.load()
		const state = loaded.get('session-race')
		if (loaded.size > 0 && state === undefined) bad++
	}
	writing = false
	await writer
	if (bad > 0) fail('store.race', 'load during write', `${bad} snapshots had a record with no readable state`)
})

// ---------------------------------------------------------------- very long id + traversal
await withRoot('ids', async (root) => {
	const store = new checkpoint.LoopStore(root)
	for (const id of ['../escape', 'a/b', '.', '..', '', 'a\u0000b', 'a'.repeat(300)]) {
		let threw = false
		try {
			await store.write({ ...makeLoop('s'), id })
		} catch {
			threw = true
		}
		if (id === 'a'.repeat(300) && !threw) note('ids: a 300-char id was accepted (ENAMETOOLONG expected on some filesystems)')
		if (id !== 'a'.repeat(300) && !threw) fail('store.ids', id, 'write accepted an id the path guard should reject')
	}
	const escaped = await readdir(join(root, '..')).catch(() => [])
	if (escaped.some((name) => name.includes('escape.json'))) fail('store.ids', 'traversal', 'a traversal id wrote outside the root')
})

// ---------------------------------------------------------------- read-only medium (non-root)
if (process.getuid?.() === 0) {
	await withRoot('readonly', async (root) => {
		chmod(root, 0o555)
		const store = new checkpoint.LoopStore(root)
		const probe = spawn('setpriv', ['--reuid=65534', '--regid=65534', '--clear-groups', process.execPath, '-e', `
			import { LoopStore } from '${new URL('./lib/types/checkpoint.js', import.meta.url).pathname}'
			import { createLoop } from '${new URL('./lib/types/loop.js', import.meta.url).pathname}'
			const store = new LoopStore(${JSON.stringify(root)})
			try { await store.write(createLoop({ sessionId: 's', objective: 'o', maxRounds: 1 })) ; console.log('WROTE') }
			catch (e) { console.log('REJECTED', e.code) }
		`], { stdio: ['ignore', 'pipe', 'pipe'] })
		let out = ''
		probe.stdout.on('data', (d) => (out += d))
		probe.stderr.on('data', (d) => (out += d))
		const code = await new Promise((resolve) => probe.on('exit', resolve))
		if (code !== 0) note(`readonly: setpriv unavailable (exit ${code}) -?skipped`)
		else {
			note(`readonly as nobody: ${out.trim()}`)
			if (!out.includes('REJECTED')) fail('store.readonly', 'EACCES', `expected a clean rejection, got: ${out.trim()}`)
		}
		chmod(root, 0o755)
	})
}

// ---------------------------------------------------------------- report
console.log('BRUTE_STORE ' + JSON.stringify({ ok: failures.length === 0, failures, observations }))
for (const text of observations) console.error(`note: ${text}`)
for (const f of failures) console.error(`FAIL [${f.area}] ${f.label}: ${f.error}`)
process.exitCode = failures.length > 0 ? 1 : 0
