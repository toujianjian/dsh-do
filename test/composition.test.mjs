import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as plugin from '../lib/index.js'

const expectedTools = ['loop_cancel', 'loop_done', 'loop_start', 'loop_status']
const lifecycleEvents = [
	'agent/error', 'agent/created', 'agent/disposed', 'agent/session-start',
	'agent/status', 'agent/inbox/inserted', 'agent/inbox/claimed',
	'agent/inbox/discarded', 'session/event', 'agent/pre-step',
	'agent/request', 'agent/request-error',
]
/**
 * Listeners dsh-do adds per event once active. `session/event` has two owners:
 * the loop driver and the model-fallback reset on a human message; the two
 * request waterfalls belong to model fallback.
 */
const ownedListeners = { 'session/event': 2 }
const WATERFALLS = new Set(['agent/pre-step', 'agent/request', 'agent/request-error'])
const expectedAdded = (baseline) => baseline.map((count, index) => count + (ownedListeners[lifecycleEvents[index]] ?? 1))

async function services(ctx, constructors = { AgentRegistry, ToolRuntime, SystemPrompt }) {
	for (const Plugin of [constructors.AgentRegistry, constructors.SystemPrompt, constructors.ToolRuntime]) {
		const fiber = ctx.plugin(Plugin, {})
		await fiber.await()
		assert.equal(fiber.state, 2)
	}
	assert.deepEqual(ctx.get('agents').list(), [])
	assert.equal(ctx.get('webServer'), undefined)
	assert.equal(ctx.get('agentDefaultModel'), undefined)
}

// Dispatch resolution inspects the real event bus rather than a fake listener map.
// No handlers are invoked, and no undocumented fiber internals are enumerated.
function listenerCounts(ctx) {
	return lifecycleEvents.map((name) => ctx.events.dispatch(WATERFALLS.has(name) ? 'waterfall' : 'emit', [name]).length)
}

async function assertRegistered(ctx, baseline) {
	// fiber.await() settles activation, not detached async ctx.effect bodies.
	// Restore is memory-only here: drain its microtasks at the next event-loop
	// boundary without polling or masking a permanently missing registration.
	await new Promise((resolve) => setImmediate(resolve))
	const tools = ctx.get('tools')
	assert.deepEqual(tools.schemas().map((tool) => tool.name).sort(), expectedTools)
	for (const name of expectedTools) assert.equal(typeof tools.get(name).execute, 'function')
	const assembly = await ctx.get('systemPrompt').assemble({})
	assert.equal(assembly.sections.filter((section) => section.name === 'tool:loop').length, 1)
	assert.match(assembly.sections.find((section) => section.name === 'tool:loop').text, /loop_start/)
	assert.deepEqual(listenerCounts(ctx), expectedAdded(baseline))
}

async function assertRemoved(ctx, baseline) {
	assert.deepEqual(ctx.get('tools').schemas(), [])
	assert.equal((await ctx.get('systemPrompt').assemble({})).sections.some((section) => section.name === 'tool:loop'), false)
	assert.deepEqual(listenerCounts(ctx), baseline)
}

test('published main entry activates with real Cordis dependencies, restarts cleanly, and disposes registrations', async (t) => {
	const ctx = new Context()
	t.after(() => ctx.fiber.dispose())
	// A real dependency gate: do not call apply() directly or supply fake ctx.
	const fiber = ctx.plugin(plugin, { persist: false })
	await fiber.await()
	assert.equal(fiber.state, 0, 'plugin must remain pending without required services')
	assert.equal(fiber.getEffects().length, 0)
	const baseline = listenerCounts(ctx)
	await services(ctx)
	await fiber.await()
	assert.equal(fiber.state, 2)
	assert.equal(fiber.config.defaultMaxRounds, 20, 'main Config schema supplies defaults')
	await assertRegistered(ctx, baseline)
	await fiber.restart()
	await fiber.await()
	assert.equal(fiber.state, 2)
	await assertRegistered(ctx, baseline)
	await fiber.dispose()
	// Installed Cordis can retain state=ACTIVE after restart -> dispose;
	// uid=null and removed contributions are the authoritative disposal checks.
	assert.equal(fiber.uid, null)
	await assertRemoved(ctx, baseline)
})

test('main entry prompt and driver listener lifecycle uses actual Cordis disposal', async (t) => {
	const ctx = new Context()
	t.after(() => ctx.fiber.dispose())
	await services(ctx)
	const baseline = listenerCounts(ctx)
	const fiber = ctx.plugin(plugin, { persist: false })
	await fiber.await()
	await new Promise((resolve) => setImmediate(resolve))
	assert.equal(fiber.state, 2)
	assert.deepEqual(listenerCounts(ctx), expectedAdded(baseline))
	assert.equal((await ctx.get('systemPrompt').assemble({})).sections.filter((section) => section.name === 'tool:loop').length, 1)
	await fiber.dispose()
	await assertRemoved(ctx, baseline)
	// An orphaned driver listener would reject this foreign loop reservation.
	const messages = [{ id: 'foreign-round', content: [], source: { kind: 'loop', loopId: 'foreign', round: 1 } }]
	const decision = await ctx.waterfall('agent/pre-step', { agent: {}, messages, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages }))
	assert.equal(decision.kind, 'enter')
})

// Optional genuine Loader lane. Point at the package.json of an installed DSH
// runtime (not a profile). Use all runtime services from that same dependency
// graph to avoid introducing a second Cordis identity. No package installs,
// profile writes, server startup, credential reads, or model executions occur.
const runtimeManifest = process.env.DSH_COMPOSITION_RUNTIME_MANIFEST

test('installed Loader mounts the single bundle row and removes it cleanly (in-memory config)', {
	skip: runtimeManifest ? false : 'Set DSH_COMPOSITION_RUNTIME_MANIFEST to an installed DSH package.json for real Loader coverage',
}, async (t) => {
	const require = createRequire(pathToFileURL(runtimeManifest))
	const load = (name) => import(pathToFileURL(require.resolve(name)).href)
	const [cordis, agent, tools, prompt, loaderModule, yaml] = await Promise.all([
		load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-agent'), load('@deepseek-ai/dsh-tools'),
		load('@deepseek-ai/dsh-system-prompt'), load('@deepseek-ai/cordis-plugin-loader'), load('yaml'),
	])
	const ctx = new cordis.Context()
	t.after(() => ctx.fiber.dispose())
	await services(ctx, { AgentRegistry: agent.AgentRegistry, ToolRuntime: tools.ToolRuntime, SystemPrompt: prompt.SystemPrompt })
	const baseline = listenerCounts(ctx)
	const loaderFiber = ctx.plugin(loaderModule.Loader, { baseUrl: new URL('../package.json', import.meta.url).href })
	await loaderFiber.await()
	assert.equal(loaderFiber.state, 2)
	const loader = ctx.get('loader')
	const patches = yaml.parse(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'))
	assert.equal(patches.length, 1)
	assert.deepEqual(Object.keys(patches[0]), ['insert'])
	assert.equal(patches[0].insert.length, 1, 'the whole bundle contributes one plugin')
	const [row] = patches[0].insert
	assert.equal(row.id, 'do')
	assert.equal(row.name, 'dsh-do')
	// This deliberately does NOT impersonate the launcher's patch merger or its
	// profile resolver: extract the sole insert row and feed the real entry tree.
	// Resolve the tested package to its main artifact and disable persistence so
	// the test cannot read/write the user's checkpoint directory.
	await loader.root.update([{ ...row, name: new URL('../lib/index.js', import.meta.url).href, config: { ...row.config, persist: false } }])
	await loader.await()
	assert.equal([...loader.entries()].length, 1)
	const entry = loader.resolve('do')
	assert.equal(entry.fiber.state, 2)
	await assertRegistered(ctx, baseline)
	await loader.remove('do')
	await loader.await()
	assert.equal([...loader.entries()].length, 0)
	await assertRemoved(ctx, baseline)
	assert.equal(ctx.get('webServer'), undefined)
})
