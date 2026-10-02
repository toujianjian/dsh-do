import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

// Real-dependency lane for the retry policy, the feature where the whole
// requirement started. Everything under test comes from the installed runtime:
// the shipping file provider supplies `settings`, and the schema is the real
// `RetryPolicySchema` that `llm-pi-ai` puts at `providers.<id>.retryPolicy`.
// A hand-written stand-in cannot answer the question that matters here --
// whether a path-level write preserves the sibling fields a union schema
// requires -- and it also cannot show how a partial user layer resolves
// against the composition entry.
const runtimeManifest = process.env.DSH_COMPOSITION_RUNTIME_MANIFEST
const lane = runtimeManifest ? false : 'Set DSH_COMPOSITION_RUNTIME_MANIFEST to an installed DSH package.json for real retry-policy coverage'

/**
 * Mount the shipping provider and register an llm-pi-ai-shaped namespace.
 * @param entry - the composition entry, i.e. the base the user layer sits on.
 */
async function retryStack(t, entry = { providers: { huoshan: { retryPolicy: { mode: 'normal', maxRetries: 5 } } } }) {
	const require = createRequire(pathToFileURL(runtimeManifest))
	const load = (name) => import(pathToFileURL(require.resolve(name)).href)
	// Load one at a time: the runtime graph mixes require() and import(), and
	// resolving several entry points concurrently trips
	// ERR_REQUIRE_ESM_RACE_CONDITION ("not yet fully loaded") inside cosmokit.
	const cordis = await load('@deepseek-ai/cordis')
	const providerModule = await load('@deepseek-ai/dsh-settings-file')
	const settingsModule = await load('@deepseek-ai/dsh-settings')
	const llmModule = await load('@deepseek-ai/dsh-llm')
	const zModule = await load('@deepseek-ai/schemastery')
	const z = zModule.default

	const dir = await mkdtemp(join(tmpdir(), 'dsh-do-retry-'))
	t.after(() => rm(dir, { recursive: true, force: true }))
	const ctx = new cordis.Context()
	t.after(() => ctx.fiber.dispose())

	const provider = ctx.plugin(providerModule.default, { path: join(dir, 'settings.json'), dshHome: dir, watch: false })
	await provider.await()
	assert.equal(provider.state, 2, 'the shipping file provider activates')

	// Same shape llm-pi-ai registers: a provider map whose profiles carry the
	// real union schema.
	const profile = z.object({ retryPolicy: llmModule.RetryPolicySchema })
	const Config = z.object({ providers: z.dict(profile).default({}) })
	settingsModule.installSettingsSection(ctx, settingsModule.settingsNamespace('llm-pi-ai'), Config, entry, {
		setSource() {},
		onChange() {},
	})
	await new Promise((resolve) => setImmediate(resolve))

	const settings = ctx.get('settings')
	assert.equal(typeof settings.mutate, 'function')
	return { settings }
}

/** Read the resolved policy the deployment would actually use. */
async function policy(settings) {
	const view = await import('../lib/types/settings-route.js')
	const section = view.readSettingsView(settings).find((entry) => entry.ns === 'llm-pi-ai')
	assert.ok(section, 'the llm-pi-ai namespace resolves through the real service')
	return section.value.providers.huoshan.retryPolicy
}

const refused = (promise) => promise.then(() => undefined, (error) => error)

test('the schema resolves the union branch and supplies its own defaults', { skip: lane }, async (t) => {
	const { settings } = await retryStack(t)
	const resolved = await policy(settings)
	assert.equal(resolved.mode, 'normal')
	assert.equal(resolved.maxRetries, 5)
	assert.ok(Array.isArray(resolved.retryableCodes), 'the normal branch defaults retryableCodes')
	// The backoff timings are NOT schema fields: resolveRetryPolicy fills them
	// when the adapter resolves the policy. Asserting them here would be
	// asserting my assumption rather than the contract.
	assert.equal('initialDelayMs' in resolved, false, 'the timings live in resolveRetryPolicy, not in the section schema')
})

test('a path-level retryPolicy write keeps mode and every sibling the union needs', { skip: lane }, async (t) => {
	const { settings } = await retryStack(t)
	const before = await policy(settings)

	// This is the write the settings page stages when the user changes one
	// retry field: a deep path, not the whole object.
	await settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'huoshan', 'retryPolicy', 'maxRetries'], value: 3 }])
	const after = await policy(settings)
	assert.equal(after.maxRetries, 3, 'the leaf landed')
	assert.equal(after.mode, before.mode, 'mode survived, so the union still resolves')
	assert.deepEqual(after.retryableCodes, before.retryableCodes, 'the sibling default survived too')
})

test('a path-level write also survives when the leaf is the backoff timings', { skip: lane }, async (t) => {
	const { settings } = await retryStack(t)
	await settings.mutate('llm-pi-ai', [
		{ op: 'set', path: ['providers', 'huoshan', 'retryPolicy', 'maxRetries'], value: 9 },
		{ op: 'set', path: ['providers', 'huoshan', 'retryPolicy', 'retryableCodes'], value: ['rate_limit'] },
	])
	const after = await policy(settings)
	assert.equal(after.maxRetries, 9)
	assert.deepEqual(after.retryableCodes, ['rate_limit'])
	assert.equal(after.mode, 'normal', 'two leaf writes in one revision-fenced request, mode intact')
})

test('with no policy in the composition entry, a partial write is refused because mode is required', { skip: lane }, async (t) => {
	// The base carries no retryPolicy here, so nothing can supply the required
	// discriminator: this is when "write the whole object" actually matters.
	const { settings } = await retryStack(t, { providers: {} })

	const partial = await refused(
		settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'huoshan', 'retryPolicy'], value: { maxRetries: 3 } }]),
	)
	assert.ok(partial, 'a policy without mode is refused when no base layer provides one')
	assert.notEqual(partial.code, 'SETTINGS_CONFLICT', 'it is a rejected value, not a stale revision')

	// The full object is accepted, and only then can a leaf be edited.
	await settings.mutate('llm-pi-ai', [
		{ op: 'set', path: ['providers', 'huoshan', 'retryPolicy'], value: { mode: 'normal', maxRetries: 5 } },
	])
	assert.equal((await policy(settings)).mode, 'normal')

	await settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'huoshan', 'retryPolicy', 'maxRetries'], value: 2 }])
	const after = await policy(settings)
	assert.equal(after.maxRetries, 2)
	assert.equal(after.mode, 'normal', 'once stored, leaves are editable in place')
})

test('unsetting the required mode is refused when nothing else supplies it', { skip: lane }, async (t) => {
	const { settings } = await retryStack(t, { providers: {} })
	await settings.mutate('llm-pi-ai', [
		{ op: 'set', path: ['providers', 'huoshan', 'retryPolicy'], value: { mode: 'normal', maxRetries: 5 } },
	])
	const removed = await refused(settings.mutate('llm-pi-ai', [{ op: 'unset', path: ['providers', 'huoshan', 'retryPolicy', 'mode'] }]))
	assert.ok(removed, 'removing the required discriminator must be refused')
	assert.equal((await policy(settings)).mode, 'normal', 'the stored policy is untouched')
})

test('an unknown mode is refused because the discriminator is a const', { skip: lane }, async (t) => {
	const { settings } = await retryStack(t, { providers: {} })
	const bogus = await refused(
		settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'huoshan', 'retryPolicy'], value: { mode: 'bogus', maxRetries: 2 } }]),
	)
	assert.ok(bogus, 'mode is a const, so an unknown discriminator must be refused')
})

test('the always branch is a distinct union member the page can select', { skip: lane }, async (t) => {
	const { settings } = await retryStack(t)
	await settings.mutate('llm-pi-ai', [
		{ op: 'set', path: ['providers', 'huoshan', 'retryPolicy'], value: { mode: 'always', maxRetries: 7 } },
	])
	const after = await policy(settings)
	assert.equal(after.mode, 'always')
	assert.equal(after.maxRetries, 7)
	assert.equal('retryableCodes' in after, false, 'retryableCodes belongs to the normal branch only')
})

test('a base-supplied policy lets a partial user layer resolve, so the page need not resend mode', { skip: lane }, async (t) => {
	// Documents the resolution rule rather than an assumption: the user layer is
	// merged onto the composition entry, so a partial user write is valid
	// whenever the entry already carries the discriminator.
	const { settings } = await retryStack(t)
	await settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'huoshan', 'retryPolicy'], value: { maxRetries: 11 } }])
	const after = await policy(settings)
	assert.equal(after.maxRetries, 11)
	assert.equal(after.mode, 'normal', 'mode came from the composition entry')
})
