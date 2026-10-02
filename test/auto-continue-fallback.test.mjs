import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideAutoContinue, renderAutoContinuePrompt } from '../lib/types/auto-continue.js'
import { chooseFallback, parseModelRoute } from '../lib/types/model-fallback.js'
import { coerceValue, executeConfigCommand, findField, parseConfigCommand, CONFIG_FIELDS } from '../lib/types/config-command.js'
import { Config, DEFAULT_FALLBACK_CODES } from '../lib/types/settings.js'

const continueOn = { enabled: true, maxContinuations: 3, onlyWhileLooping: true }

test('auto-continue continues an armed loop up to the cap, then stops', () => {
	assert.deepEqual(decideAutoContinue(continueOn, 0, true), { kind: 'continue', attempt: 1 })
	assert.deepEqual(decideAutoContinue(continueOn, 2, true), { kind: 'continue', attempt: 3 })
	assert.deepEqual(decideAutoContinue(continueOn, 3, true), { kind: 'stop', reason: 'exhausted' })
})

test('auto-continue respects the switch and the loop-only scope', () => {
	assert.deepEqual(decideAutoContinue({ ...continueOn, enabled: false }, 0, true), { kind: 'stop', reason: 'disabled' })
	assert.deepEqual(decideAutoContinue(continueOn, 0, false), { kind: 'stop', reason: 'not-looping' })
	assert.equal(decideAutoContinue({ ...continueOn, onlyWhileLooping: false }, 0, false).kind, 'continue')
})

test('the continuation prompt asks for a seamless resume, not a restart', () => {
	const text = renderAutoContinuePrompt(2, 3)[0].text
	assert.match(text, /2\/3/)
	assert.match(text, /Continue exactly where it stopped/)
	assert.match(text, /Do not restart/)
})

test('model routes keep slashes inside the model id', () => {
	assert.deepEqual(parseModelRoute('openrouter/anthropic/claude-sonnet'), { provider: 'openrouter', model: 'anthropic/claude-sonnet' })
	assert.deepEqual(parseModelRoute(' deepseek / deepseek-chat '), { provider: 'deepseek', model: 'deepseek-chat' })
	for (const bad of ['', 'noslash', '/model', 'provider/']) assert.equal(parseModelRoute(bad), undefined, bad)
})

const fallbackOn = { enabled: true, candidates: ['a/one', 'b/two', 'c/three'], triggerCodes: ['RATE_LIMIT', 'SERVER'] }

test('fallback walks the candidates in order and skips the failing and used ones', () => {
	const primary = { provider: 'p', model: 'main' }
	assert.deepEqual(chooseFallback(fallbackOn, primary, [primary], 'RATE_LIMIT'), { kind: 'switch', route: { provider: 'a', model: 'one' } })
	const one = { provider: 'a', model: 'one' }
	assert.deepEqual(chooseFallback(fallbackOn, one, [primary, one], 'SERVER'), { kind: 'switch', route: { provider: 'b', model: 'two' } })
	// A candidate equal to the failing route is never chosen.
	assert.deepEqual(chooseFallback({ ...fallbackOn, candidates: ['p/main', 'a/one'] }, primary, [primary], 'RATE_LIMIT').route, one)
})

test('fallback keeps the original error when off, untriggered, or exhausted', () => {
	const primary = { provider: 'p', model: 'main' }
	assert.deepEqual(chooseFallback({ ...fallbackOn, enabled: false }, primary, [primary], 'RATE_LIMIT'), { kind: 'keep', reason: 'disabled' })
	assert.deepEqual(chooseFallback(fallbackOn, primary, [primary], 'INVALID_CREDENTIAL'), { kind: 'keep', reason: 'code' })
	const used = ['a/one', 'b/two', 'c/three'].map(parseModelRoute)
	assert.deepEqual(chooseFallback(fallbackOn, used[2], [primary, ...used], 'RATE_LIMIT'), { kind: 'keep', reason: 'exhausted' })
})

test('the schema defaults are safe: auto-continue on, fallback off, 429 among triggers', () => {
	const resolved = Config({})
	assert.deepEqual(resolved.autoContinue, { enabled: true, maxContinuations: 3, onlyWhileLooping: true })
	assert.equal(resolved.modelFallback.enabled, false)
	assert.deepEqual(resolved.modelFallback.candidates, [])
	assert.deepEqual(resolved.modelFallback.triggerCodes, DEFAULT_FALLBACK_CODES)
	assert.ok(DEFAULT_FALLBACK_CODES.includes('RATE_LIMIT'))
})

test('config values are coerced loosely', () => {
	const flag = findField('autoContinue.enabled')
	for (const raw of ['true', 'on', '开', 'yes']) assert.deepEqual(coerceValue(flag, raw), { ok: true, value: true })
	for (const raw of ['false', 'off', '关', 'no']) assert.deepEqual(coerceValue(flag, raw), { ok: true, value: false })
	assert.equal(coerceValue(flag, 'maybe').ok, false)
	const count = findField('maxContinuations')
	assert.deepEqual(coerceValue(count, '5'), { ok: true, value: 5 })
	assert.equal(coerceValue(count, '0').ok, false)
	const list = findField('candidates')
	assert.deepEqual(coerceValue(list, 'a/x, b/y，c/z'), { ok: true, value: ['a/x', 'b/y', 'c/z'] })
	assert.deepEqual(coerceValue(list, '["a/x","b/y"]'), { ok: true, value: ['a/x', 'b/y'] })
	assert.deepEqual(coerceValue(list, '-'), { ok: true, value: [] })
})

test('the command parser accepts both "path value" and "path=value"', () => {
	assert.deepEqual(parseConfigCommand(''), { kind: 'list' })
	assert.deepEqual(parseConfigCommand('file'), { kind: 'file' })
	assert.deepEqual(parseConfigCommand('reset modelFallback.enabled'), { kind: 'reset', path: 'modelFallback.enabled' })
	assert.deepEqual(parseConfigCommand('modelFallback.enabled on'), { kind: 'set', path: 'modelFallback.enabled', raw: 'on' })
	assert.deepEqual(parseConfigCommand('autoContinue.enabled'), { kind: 'show', path: 'autoContinue.enabled' })
})

test('every config field is a real schema leaf', () => {
	const resolved = Config({})
	for (const field of CONFIG_FIELDS) {
		const value = field.path.split('.').reduce((at, key) => at?.[key], resolved)
		assert.notEqual(value, undefined, field.path)
	}
})

/** Settings service stand-in with real path semantics. */
function fakeSettings() {
	const user = {}
	const resolve = () => Config(structuredClone(user))
	const ops = []
	return {
		ops,
		get: (ns) => (ns === 'dsh-do' ? resolve() : undefined),
		async mutate(ns, list) {
			assert.equal(ns, 'dsh-do')
			for (const op of list) {
				ops.push(op)
				let at = user
				for (const key of op.path.slice(0, -1)) at = at[key] ??= {}
				const leaf = op.path.at(-1)
				if (op.op === 'set') at[leaf] = op.value
				else delete at[leaf]
			}
			resolve() // validates like the real service
		},
	}
}

test('/do-config writes through the settings service and reads the new value back', async () => {
	const settings = fakeSettings()
	const set = await executeConfigCommand(settings, 'modelFallback.candidates deepseek/deepseek-chat, openai/gpt-4o', 'X')
	assert.equal(set.ok, true)
	assert.deepEqual(settings.ops.at(-1), { op: 'set', path: ['modelFallback', 'candidates'], value: ['deepseek/deepseek-chat', 'openai/gpt-4o'] })
	assert.match(set.lines[0], /deepseek\/deepseek-chat, openai\/gpt-4o/)

	await executeConfigCommand(settings, 'fallback=on', 'X') // unknown short path is rejected, not guessed
	const on = await executeConfigCommand(settings, 'modelFallback.enabled=on', 'X')
	assert.equal(on.ok, true)
	assert.equal(settings.get('dsh-do').modelFallback.enabled, true)

	const reset = await executeConfigCommand(settings, 'reset modelFallback.enabled', 'X')
	assert.equal(reset.ok, true)
	assert.equal(settings.get('dsh-do').modelFallback.enabled, false)

	const listing = await executeConfigCommand(settings, '', 'X')
	assert.equal(listing.lines.length, CONFIG_FIELDS.length + 1)
	assert.match((await executeConfigCommand(settings, 'file', 'C:/h/settings.yaml')).lines[0], /settings\.yaml/)
})

test('/do-config refuses bad input without writing', async () => {
	const settings = fakeSettings()
	assert.equal((await executeConfigCommand(settings, 'nope 1', 'X')).ok, false)
	assert.equal((await executeConfigCommand(settings, 'autoContinue.maxContinuations zero', 'X')).ok, false)
	assert.equal(settings.ops.length, 0)
	assert.equal((await executeConfigCommand(undefined, '', 'X')).ok, false)
})
