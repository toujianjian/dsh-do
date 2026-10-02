import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { parseSettingsWriteRequest } from '../lib/types/settings-route.js'

// --- pure parser lane (always runs) ---------------------------------------
// The real `applyPathOp` throws a TypeError for a root set whose value is not a
// plain object, so the parser has to refuse that shape itself: otherwise a
// malformed request is reported as a service-internal failure instead of a 400
// about the request. Verified against the shipping service by the lane below.

test('the parser refuses a non-object root set before the service sees it', () => {
	for (const value of [5, 'text', null, true, [1, 2]]) {
		const parsed = parseSettingsWriteRequest({ ns: 'dsh-do', ops: [{ op: 'set', path: [], value }] })
		assert.equal(parsed.ok, false, `a root set of ${JSON.stringify(value)} must be refused`)
		assert.match(parsed.error, /plain object/)
	}
	// A plain object root set is still how the whole section is saved, and a
	// nested path is unaffected by the root rule.
	assert.equal(parseSettingsWriteRequest({ ns: 'dsh-do', ops: [{ op: 'set', path: [], value: { defaultMaxRounds: 3 } }] }).ok, true)
	assert.equal(parseSettingsWriteRequest({ ns: 'dsh-do', ops: [{ op: 'set', path: ['persist'], value: false }] }).ok, true)
	assert.equal(parseSettingsWriteRequest({ ns: 'dsh-do', ops: [{ op: 'unset', path: [] }] }).ok, true)
})

// --- real-dependency lane -------------------------------------------------
// Mount the SHIPPING file provider so `mutate`, `applyPathOp`, revision fencing,
// schema resolution and the SETTINGS_CONFLICT machine code under test are the
// ones a deployment runs -- not a hand-written stand-in that can only confirm
// the assumptions of whoever wrote it. Every runtime module comes from the same
// installed graph, so no second Cordis identity is introduced.
const runtimeManifest = process.env.DSH_COMPOSITION_RUNTIME_MANIFEST
const lane = runtimeManifest ? false : 'Set DSH_COMPOSITION_RUNTIME_MANIFEST to an installed DSH package.json for real settings coverage'

async function realStack(t) {
	const require = createRequire(pathToFileURL(runtimeManifest))
	const load = (name) => import(pathToFileURL(require.resolve(name)).href)
	const [cordis, agent, tools, prompt, providerModule, plugin] = await Promise.all([
		load('@deepseek-ai/cordis'),
		load('@deepseek-ai/dsh-agent'),
		load('@deepseek-ai/dsh-tools'),
		load('@deepseek-ai/dsh-system-prompt'),
		load('@deepseek-ai/dsh-settings-file'),
		import('../lib/index.js'),
	])

	const dir = await mkdtemp(join(tmpdir(), 'dsh-do-settings-'))
	t.after(() => rm(dir, { recursive: true, force: true }))
	const ctx = new cordis.Context()
	t.after(() => ctx.fiber.dispose())

	const provider = ctx.plugin(providerModule.default, { path: join(dir, 'settings.json'), dshHome: dir, watch: false })
	await provider.await()
	assert.equal(provider.state, 2, 'the shipping file provider activates')

	for (const Plugin of [agent.AgentRegistry, prompt.SystemPrompt, tools.ToolRuntime]) {
		const fiber = ctx.plugin(Plugin, {})
		await fiber.await()
		assert.equal(fiber.state, 2)
	}
	const mounted = ctx.plugin(plugin, { persist: false })
	await mounted.await()
	assert.equal(mounted.state, 2, 'the plugin mounts against the real settings service')
	await new Promise((resolve) => setImmediate(resolve))

	const settings = ctx.get('settings')
	assert.equal(typeof settings.mutate, 'function')
	return { settings }
}

test('the page reads the real registered dsh-do namespace with its revision', { skip: lane }, async (t) => {
	const { settings } = await realStack(t)
	const view = await import('../lib/types/settings-route.js')
	const dshDo = view.readSettingsView(settings).find((section) => section.ns === 'dsh-do')
	assert.ok(dshDo, 'the plugin registered the dsh-do namespace against the real service')
	assert.equal(typeof dshDo.revision, 'number')
	assert.equal(dshDo.value.defaultMaxRounds, 20, 'the composition entry resolves through the real schema')
})

test('a leaf write leaves sibling fields of the real section untouched', { skip: lane }, async (t) => {
	const { settings } = await realStack(t)
	const view = await import('../lib/types/settings-route.js')
	const read = () => view.readSettingsView(settings).find((section) => section.ns === 'dsh-do')

	const before = read()
	await settings.mutate('dsh-do', [{ op: 'set', path: ['defaultMaxRounds'], value: 7 }], before.revision)
	const afterFirst = read()
	assert.equal(afterFirst.value.defaultMaxRounds, 7)
	assert.equal(afterFirst.value.persist, before.value.persist, 'the sibling survived the leaf write')
	assert.equal(afterFirst.value.checkpointDir, before.value.checkpointDir)

	await settings.mutate('dsh-do', [{ op: 'set', path: ['persist'], value: false }], afterFirst.revision)
	const afterSecond = read()
	assert.equal(afterSecond.value.persist, false)
	assert.equal(afterSecond.value.defaultMaxRounds, 7, 'the first write survived the second')
	assert.ok(afterSecond.revision > before.revision, 'the revision advanced')
})

test('a stale revision carries the documented SETTINGS_CONFLICT code', { skip: lane }, async (t) => {
	const { settings } = await realStack(t)
	const view = await import('../lib/types/settings-route.js')
	const read = () => view.readSettingsView(settings).find((section) => section.ns === 'dsh-do')

	const before = read()
	await settings.mutate('dsh-do', [{ op: 'set', path: ['defaultMaxRounds'], value: 5 }], before.revision)
	const stale = await settings
		.mutate('dsh-do', [{ op: 'set', path: ['defaultMaxRounds'], value: 6 }], before.revision)
		.then(() => undefined, (error) => error)
	assert.ok(stale, 'the stale write is refused')
	// This machine code is what the route keys on to answer 409; every other
	// failure must not be reported as a stale revision.
	assert.equal(stale.code, 'SETTINGS_CONFLICT')
})

test('a rejected value is not a conflict, so the route must not answer 409', { skip: lane }, async (t) => {
	const { settings } = await realStack(t)
	const view = await import('../lib/types/settings-route.js')
	const before = view.readSettingsView(settings).find((section) => section.ns === 'dsh-do')

	const refused = await settings
		.mutate('dsh-do', [{ op: 'set', path: ['defaultMaxRounds'], value: 'lots' }], before.revision)
		.then(() => undefined, (error) => error)
	assert.ok(refused, 'the real schema refuses a wrong-typed value')
	assert.notEqual(refused.code, 'SETTINGS_CONFLICT', 'a rejected value is not a stale revision')
})

test('the real service refuses a scalar root set, which is why the parser must', { skip: lane }, async (t) => {
	const { settings } = await realStack(t)
	const view = await import('../lib/types/settings-route.js')
	const before = view.readSettingsView(settings).find((section) => section.ns === 'dsh-do')

	const thrown = await settings
		.mutate('dsh-do', [{ op: 'set', path: [], value: 5 }], before.revision)
		.then(() => undefined, (error) => error)
	assert.ok(thrown instanceof TypeError, 'the shipping service rejects a scalar root set')
	assert.match(thrown.message, /plain object/)
})
