/**
 * DSH 0.2.x adaptation.
 *
 * DSH 0.2.0-rc.2 reworked the settings service: namespace registration is gone,
 * sections are keyed by profile entry id, and only `.volatile()` fields are
 * projected. These tests pin the compatibility behaviour that keeps one build
 * working on both 0.1.x and 0.2.x, using fakes that mirror each real service
 * shape rather than a convenient approximation.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config, DSH_DO_NS, installDoSettings, isDoSection, plainSettings } from '../lib/types/settings.js'
import { readSettingsView } from '../lib/types/settings-route.js'
import { adaptSettingsAccess } from '../lib/types/config-command.js'
import { resolveDoNamespace } from '../lib/types/client/doSettings.js'

/**
 * Build a live config reference exactly the way the runtime does: a frozen
 * object carrying `get()` and the registered `cosmokit.volatile.write` symbol.
 * The symbol is global, so this is the real protocol, not a stand-in.
 */
const write = Symbol.for('cosmokit.volatile.write')
function reference(initial) {
	let current = initial
	return Object.freeze({
		get: () => current,
		[write]: (next) => {
			current = next
		},
	})
}

const FULL = {
	defaultMaxRounds: 20,
	checkpointDir: '',
	persist: true,
	loopDetection: { enabled: true, repeatThreshold: 4, compact: true, maxInterventions: 2 },
	autoContinue: { enabled: true, maxContinuations: 3, onlyWhileLooping: true },
	modelFallback: { enabled: false, candidates: [], triggerCodes: ['RATE_LIMIT'] },
}

/** A 0.2.x settings service: `describe`/`mutate`, keyed by profile entry id. */
function formsSettings(sections) {
	const state = new Map(sections.map((row) => [row.ns, { ...row }]))
	return {
		calls: [],
		describe() {
			return [...state.values()].map((row) => ({ ns: row.ns, value: row.value, revision: row.revision ?? 0 }))
		},
		async mutate(ns, ops) {
			this.calls.push({ ns, ops })
			return undefined
		},
		has(ns) {
			return state.has(ns)
		},
	}
}

test('plainSettings resolves live references instead of leaking the wrapper', () => {
	const live = { defaultMaxRounds: reference(20), nested: { enabled: reference(true) }, list: [reference('a')] }
	assert.deepEqual(plainSettings(live), {
		defaultMaxRounds: 20,
		nested: { enabled: true },
		list: ['a'],
	})
	// A plain config passes through untouched, so 0.1.x is unaffected.
	assert.deepEqual(plainSettings(FULL), FULL)
})

test('plainSettings reads through a reference on every call, so a live edit is visible', () => {
	const maxRounds = reference(20)
	const config = { defaultMaxRounds: maxRounds }
	assert.equal(plainSettings(config).defaultMaxRounds, 20)
	// The runtime updates the reference in place; a cached snapshot would miss it.
	maxRounds[write](7)
	assert.equal(plainSettings(config).defaultMaxRounds, 7)
})

test('isDoSection recognises the section by its fields, not by the namespace it is filed under', () => {
	// 0.2.x keys the section by profile entry id, which the deployment chooses.
	assert.equal(isDoSection('do', FULL), true)
	assert.equal(isDoSection('anything-else', FULL), true)
	// 0.1.x keeps the registered namespace even if the value is not yet resolved.
	assert.equal(isDoSection(DSH_DO_NS, undefined), true)
	// Another plugin's section is not mistaken for this one.
	assert.equal(isDoSection('llm-pi-ai', { providers: {} }), false)
	assert.equal(isDoSection('agent-default-model', { provider: 'x', model: 'y' }), false)
	assert.equal(isDoSection('scalar', 3), false)
})

test('the bridge serves the dsh-do section under a profile entry id', () => {
	const views = readSettingsView(formsSettings([
		{ ns: 'agent-default-model', value: { provider: 'deepseek-official', model: 'deepseek-flash' }, revision: 0 },
		{ ns: 'do', value: FULL, revision: 3 },
	]))
	assert.deepEqual(views.map((view) => view.ns), ['agent-default-model', 'do'])
	assert.equal(views[1].revision, 3)
	assert.deepEqual(views[1].value, FULL)
})

test('a settings service without namespace registration is left alone, and the entry stays the live source', () => {
	const applied = []
	// The 0.2.x shape: `settings` exists but has no `register`.
	const child = { settings: { describe: () => [], mutate: async () => undefined }, effect: (fn) => fn() }
	const ctx = { inject: (_deps, fn) => fn(child), effect: (fn) => fn(), fiber: { state: 2 } }
	const maxRounds = reference(20)
	const entry = { ...FULL, defaultMaxRounds: maxRounds }

	// Must not throw: calling a removed `register` would abort the plugin load.
	const source = installDoSettings(ctx, entry, (next) => applied.push(next))

	assert.equal(source.read().defaultMaxRounds, 20)
	assert.equal(applied.length, 0, 'nothing is re-applied before a committed change')
	// The runtime edits the reference in place; the reader must follow it even
	// though no settings namespace was ever registered.
	maxRounds[write](7)
	assert.equal(source.read().defaultMaxRounds, 7)
})

test('adaptSettingsAccess presents a 0.2.x service as the access face the command uses', async () => {
	const service = formsSettings([{ ns: 'do', value: FULL, revision: 0 }])
	const access = adaptSettingsAccess(service)
	assert.notEqual(access, undefined)
	// The command asks for `dsh-do`; the service files it under the entry id.
	assert.deepEqual(access.get(DSH_DO_NS), FULL)
	await access.mutate(DSH_DO_NS, [{ op: 'set', path: ['defaultMaxRounds'], value: 7 }])
	assert.deepEqual(service.calls, [{ ns: 'do', ops: [{ op: 'set', path: ['defaultMaxRounds'], value: 7 }] }])
})

test('adaptSettingsAccess keeps the 0.1.x service exactly as it was', () => {
	const service = { get: (ns) => ({ ns }), mutate: async () => undefined }
	assert.equal(adaptSettingsAccess(service), service)
	// A service offering neither shape is refused rather than half-wrapped.
	assert.equal(adaptSettingsAccess({ get: () => undefined }), undefined)
	assert.equal(adaptSettingsAccess(undefined), undefined)
})

test('the client resolves the section namespace by shape, falling back to the registered one', () => {
	const byNs = (rows) => new Map(rows.map((row) => [row.ns, row]))
	// 0.2.x: the entry id is the only handle, and it is not known to the client.
	assert.equal(resolveDoNamespace(byNs([
		{ ns: 'agent-default-model', value: { provider: 'x', model: 'y' } },
		{ ns: 'do', value: FULL },
	])), 'do')
	// 0.1.x: the registered namespace wins when present.
	assert.equal(resolveDoNamespace(byNs([{ ns: DSH_DO_NS, value: FULL }])), DSH_DO_NS)
	// Nothing served means nothing to read or write.
	assert.equal(resolveDoNamespace(byNs([{ ns: 'llm-pi-ai', value: { providers: {} } }])), undefined)
})

test('Config marks itself volatile only where the runtime implements the marker', () => {
	// The repo resolves a schemastery older than the one that added `.volatile()`,
	// so this asserts the feature detection rather than a fixed outcome: the
	// plugin must load either way, and the schema must stay resolvable.
	const schema = Config.toJSON()
	const hasMarker = typeof Config.volatile === 'function'
	assert.equal(typeof Config, 'function')
	assert.equal(hasMarker, false, 'the local schemastery predates volatile(); the guard must have skipped it')
	assert.equal(schema.meta?.volatile, undefined)
	// Field defaults are untouched by the marking.
	const resolved = Config({})
	assert.equal(resolved.defaultMaxRounds, 20)
	assert.deepEqual(resolved.autoContinue, { enabled: true, maxContinuations: 3, onlyWhileLooping: true })
})
