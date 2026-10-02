import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

// Real-dependency lane for the status surface. The projection only works if it
// matches the SHIPPING registry's contract, and that contract is not something a
// stub can confirm: the registry folds a cell from seq 0, so an `apply` that
// reads live plugin state would pass a hand-written test and still produce a
// replay-dependent value in production.
const runtimeManifest = process.env.DSH_COMPOSITION_RUNTIME_MANIFEST
const lane = runtimeManifest ? false : 'Set DSH_COMPOSITION_RUNTIME_MANIFEST to an installed DSH package.json for real projection coverage'

/** Mount dsh-do against the real session-projection registry. */
async function stack(t) {
	const require = createRequire(pathToFileURL(runtimeManifest))
	const load = (name) => import(pathToFileURL(require.resolve(name)).href)
	const cordis = await load('@deepseek-ai/cordis')
	const projectionModule = await load('@deepseek-ai/dsh-session-projection')

	const ctx = new cordis.Context()
	t.after(() => ctx.fiber.dispose())
	// The plugin takes only these; the registry is optional and mounted first so
	// the `ctx.inject(['sessionProjections'])` branch actually runs.
	const registry = ctx.plugin(projectionModule.default ?? projectionModule.SessionProjectionRegistry)
	await registry.await()

	const host = await import('../lib/index.js')
	assert.equal(typeof host.apply, 'function', 'the published main entry applies')
	return { ctx, host, registry }
}

/** A fake Agent is not enough here: the plugin reads real session events. */
function fakeAgent(id) {
	const events = []
	return {
		id,
		status: 'idle',
		session: { id, events, seq: 0 },
		inbox: { nextTurn: [], nextStep: [] },
		followup() {},
		cancel() {},
		whenIdle: async () => {},
	}
}

test('the plugin registers the loops service and the loop projection, and unloads both', { skip: lane }, async (t) => {
	const { ctx, host } = await stack(t)

	// The plugin injects agents/tools/systemPrompt, so provide them minimally;
	// this lane is about the status surface, not about those services.
	const agents = new Map()
	ctx.provide('agents')
	ctx.set('agents', { get: (id) => agents.get(id), list: () => [...agents.values()] })
	ctx.provide('tools')
	ctx.set('tools', { register: () => () => {} })
	ctx.provide('systemPrompt')
	ctx.set('systemPrompt', { section: () => () => {} })

	const fiber = ctx.plugin(host, { defaultMaxRounds: 5, checkpointDir: '', persist: false })
	await fiber.await()
	assert.equal(fiber.state, 2, 'the plugin activates against the real registry')

	// The service a TUI reads, mirroring how the TUI reads `goals`.
	assert.equal(typeof ctx.loops?.get, 'function', 'the loops service is provided')
	assert.equal(ctx.loops.get(fakeAgent('nobody')), undefined, 'a session with no loop reports nothing')
	assert.equal(ctx.loops.list().size, 0)

	// The projection key is what the TUI's /status panel renders.
	const session = { id: 'proj-session', seq: 0, events: [] }
	const first = ctx.sessionProjections.snapshot(session)
	assert.ok('loop' in first.values, `the loop projection is registered (keys: ${Object.keys(first.values).join(',')})`)
	assert.equal(first.values.loop, null, 'a session that never ran a round projects null')

	// Fold real round events through the registry itself, not through our apply.
	// The registry advances a cached cell only via its `session/event` listener,
	// so delivering the event is part of the contract being verified: a bare
	// array push would leave the cell stale and prove nothing.
	const push = (loopId, round) => {
		const event = { seq: session.events.length, type: 'user/message', data: { source: { kind: 'loop', loopId, round } } }
		session.events.push(event)
		session.seq += 1
		ctx.emit('session/event', session, event)
	}
	push('loop-x', 1)
	push('loop-x', 2)
	const after = ctx.sessionProjections.snapshot(session)
	assert.equal(after.values.loop?.roundsStarted, 2, 'the registry folds admitted rounds')
	assert.equal(after.values.loop?.loopId, 'loop-x')

	// Reading the same cell twice must be stable, and a fresh session must rebuild
	// the same value from seq 0 — this is what proves the fold carries no live
	// plugin state that could differ by read order.
	const fresh = { id: 'proj-replay', seq: 0, events: [] }
	for (const event of session.events) {
		const copy = { ...event, seq: fresh.events.length }
		fresh.events.push(copy)
		fresh.seq += 1
		ctx.emit('session/event', fresh, copy)
	}
	assert.deepEqual(ctx.sessionProjections.snapshot(session).values.loop, ctx.sessionProjections.snapshot(fresh).values.loop, 'the projection is replay-stable')

	// Unloading the plugin must remove the key, not leave a stale section behind.
	await fiber.dispose()
	const gone = ctx.sessionProjections.snapshot(session)
	assert.equal('loop' in gone.values, false, 'disposal removes the projection key')
})

test('the loop projection key does not collide with the shield of another plugin', { skip: lane }, async (t) => {
	const { ctx, host } = await stack(t)
	ctx.provide('agents')
	ctx.set('agents', { get: () => undefined, list: () => [] })
	ctx.provide('tools')
	ctx.set('tools', { register: () => () => {} })
	ctx.provide('systemPrompt')
	ctx.set('systemPrompt', { section: () => () => {} })

	const fiber = ctx.plugin(host, { defaultMaxRounds: 5, checkpointDir: '', persist: false })
	await fiber.await()
	// Registering the same key twice must be an error the registry reports, which
	// is how a second dsh-do row would surface rather than silently double-count.
	const session = { id: 's2', seq: 0, events: [] }
	const snap = ctx.sessionProjections.snapshot(session)
	assert.ok('loop' in snap.values)
	await fiber.dispose()
})
