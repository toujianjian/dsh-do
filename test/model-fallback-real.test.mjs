import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

// Real Cordis waterfalls. The fallback is only correct if (a) the provider's own
// retry listener still runs before a switch, and (b) the request override is the
// OUTERMOST `agent/request` listener so the session model selection cannot undo
// it. Both are ordering facts of the real event bus, which a hand-rolled
// dispatcher cannot confirm.
const runtimeManifest = process.env.DSH_COMPOSITION_RUNTIME_MANIFEST
const lane = runtimeManifest ? false : 'Set DSH_COMPOSITION_RUNTIME_MANIFEST to an installed DSH package.json'

async function stack(t, policy) {
	const require = createRequire(pathToFileURL(runtimeManifest))
	const cordis = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)
	const { installModelFallback } = await import('../lib/types/model-fallback.js')
	const ctx = new cordis.Context()
	t.after(() => ctx.fiber.dispose())
	const agent = { id: 'fb-agent', session: { id: 'fb-agent' } }
	ctx.provide('agents')
	ctx.set('agents', { get: (id) => (id === agent.id ? agent : undefined), list: () => [agent] })
	ctx.provide('logger')

	// Mounted BEFORE the plugin, like the session model selection and
	// dsh-llm-retry in a real composition.
	const selection = { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' }
	ctx.on('agent/request', async (_payload, next) => ({ ...(await next()), ...selection }))
	const retry = { remaining: 0, calls: 0 }
	ctx.on('agent/request-error', async (_payload, next) => {
		retry.calls += 1
		if (retry.remaining > 0) {
			retry.remaining -= 1
			return { kind: 'retry' }
		}
		return next()
	})

	const handle = installModelFallback(ctx, () => policy)
	const request = () => ctx.waterfall('agent/request', { agent, turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ provider: 'seed', model: 'seed' }))
	const fail = (code) =>
		ctx.waterfall(
			'agent/request-error',
			{ agent, turn: 1, step: 1, provider: 'x', failure: { code, message: code }, retryPolicy: undefined, signal: new AbortController().signal },
			async () => undefined,
		)
	return { ctx, agent, handle, request, fail, retry, selection }
}

const policy = { enabled: true, candidates: ['openai/gpt-4o', 'moonshot/kimi-k2'], triggerCodes: ['RATE_LIMIT', 'SERVER'] }

test('a 429 switches to the first candidate after the retry policy gives up', { skip: lane }, async (t) => {
	const s = await stack(t, policy)
	assert.deepEqual(await s.request(), { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' })
	s.retry.remaining = 2
	assert.deepEqual(await s.fail('RATE_LIMIT'), { kind: 'retry' }, 'the provider retry still owns the first attempts')
	assert.equal(s.handle.view(s.agent), undefined, 'no switch while the provider is still retrying')
	await s.fail('RATE_LIMIT')
	assert.deepEqual(await s.fail('RATE_LIMIT'), { kind: 'retry' }, 'retry exhausted -> fallback retries on a new model')
	const switched = await s.request()
	assert.equal(switched.provider, 'openai')
	assert.equal(switched.model, 'gpt-4o')
	assert.equal(switched.reasoningEffort, undefined, 'an effort chosen for the old model is dropped')
	assert.deepEqual(s.handle.view(s.agent), { override: 'openai/gpt-4o', tried: ['deepseek/deepseek-chat', 'openai/gpt-4o'] })
})

test('the switch walks the list and the final failure stands', { skip: lane }, async (t) => {
	const s = await stack(t, policy)
	await s.request()
	assert.deepEqual(await s.fail('SERVER'), { kind: 'retry' })
	await s.request()
	assert.deepEqual(await s.fail('SERVER'), { kind: 'retry' })
	assert.equal((await s.request()).provider, 'moonshot')
	assert.equal(await s.fail('SERVER'), undefined, 'every candidate failed: the original error stands')
})

test('switched off, or on an untriggered code, behaviour is unchanged', { skip: lane }, async (t) => {
	const off = await stack(t, { ...policy, enabled: false })
	await off.request()
	assert.equal(await off.fail('RATE_LIMIT'), undefined)
	assert.equal((await off.request()).provider, 'deepseek')

	const auth = await stack(t, policy)
	await auth.request()
	assert.equal(await auth.fail('INVALID_CREDENTIAL'), undefined)
	assert.equal((await auth.request()).provider, 'deepseek')
})

test('a human message sends the next request back to the user model', { skip: lane }, async (t) => {
	const s = await stack(t, policy)
	await s.request()
	await s.fail('RATE_LIMIT')
	assert.equal((await s.request()).provider, 'openai')
	// A loop round or plugin notice does not reset it...
	s.ctx.emit('session/event', s.agent.session, { type: 'user/message', data: { source: { kind: 'loop' } } })
	assert.equal((await s.request()).provider, 'openai')
	// ...a real human message does.
	s.ctx.emit('session/event', s.agent.session, { type: 'user/message', data: { source: { kind: 'user' } } })
	assert.equal((await s.request()).provider, 'deepseek')
})

test('turning the switch off mid-episode stops overriding at once', { skip: lane }, async (t) => {
	const live = { ...policy }
	const s = await stack(t, live)
	await s.request()
	await s.fail('RATE_LIMIT')
	assert.equal((await s.request()).provider, 'openai')
	live.enabled = false
	assert.equal((await s.request()).provider, 'deepseek')
})
