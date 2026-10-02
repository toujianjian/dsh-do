import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Real file-backed settings: the shipped `dsh-settings` service with the shipped
// `dsh-settings-file` provider watching a temp `settings.yaml`, the same pair
// both the web and tui profiles mount. This is the only way to confirm that a
// hand edit of the file reaches dsh-do live and that `/do-config` writes back to
// that file, rather than to an in-memory stand-in.
const runtimeManifest = process.env.DSH_COMPOSITION_RUNTIME_MANIFEST
const lane = runtimeManifest ? false : 'Set DSH_COMPOSITION_RUNTIME_MANIFEST to an installed DSH package.json'

async function waitFor(predicate, what, timeoutMs = 8000) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (await predicate()) return
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
	assert.fail(`timed out waiting for ${what}`)
}

async function stack(t) {
	const require = createRequire(pathToFileURL(runtimeManifest))
	const load = async (name) => import(pathToFileURL(require.resolve(name)).href)
	// Sequential: concurrent dynamic import of these ESM packages races.
	const cordis = await load('@deepseek-ai/cordis')
	const settingsModule = await load('@deepseek-ai/dsh-settings')
	const fileModule = await load('@deepseek-ai/dsh-settings-file')
	const { installDoSettings, Config } = await import('../lib/types/settings.js')
	const { executeConfigCommand } = await import('../lib/types/config-command.js')

	const home = await mkdtemp(join(tmpdir(), 'dsh-do-cfg-'))
	t.after(() => rm(home, { recursive: true, force: true }))
	const file = join(home, 'settings.yaml')
	await writeFile(file, 'other-plugin:\n  keep: me\n')

	const ctx = new cordis.Context()
	t.after(() => ctx.fiber.dispose())
	// The file provider IS the `settings` service (it extends SettingsProvider),
	// exactly as the profiles compose it; there is no separate base row.
	void settingsModule
	const provider = ctx.plugin(fileModule.FileSettingsProvider, { path: file, debounceMs: 20 })
	await provider.await()
	assert.equal(provider.state, 2, 'the file provider is active')

	let current = Config({})
	const fiber = ctx.plugin({
		name: 'dsh-do-settings-probe',
		apply(child) {
			const source = installDoSettings(child, Config({}), (next) => {
				current = next
			})
			current = source.read()
		},
	})
	await fiber.await()
	return { ctx, file, read: () => current, run: (text) => executeConfigCommand(ctx.get('settings'), text, file) }
}

test('a hand edit of settings.yaml reaches dsh-do without a restart', { skip: lane }, async (t) => {
	const s = await stack(t)
	assert.equal(s.read().modelFallback.enabled, false)
	await writeFile(
		s.file,
		[
			'other-plugin:',
			'  keep: me',
			'dsh-do:',
			'  autoContinue:',
			'    maxContinuations: 7',
			'  modelFallback:',
			'    enabled: true',
			'    candidates:',
			'      - deepseek/deepseek-chat',
			'      - openai/gpt-4o',
			'',
		].join('\n'),
	)
	await waitFor(() => s.read().modelFallback.enabled === true, 'the file edit to be applied')
	assert.deepEqual(s.read().modelFallback.candidates, ['deepseek/deepseek-chat', 'openai/gpt-4o'])
	assert.equal(s.read().autoContinue.maxContinuations, 7)
	// Keys not written keep their defaults: a partial section is enough.
	assert.equal(s.read().autoContinue.enabled, true)
	assert.equal(s.read().defaultMaxRounds, 20)
})

test('an invalid file edit keeps the last good value', { skip: lane }, async (t) => {
	const s = await stack(t)
	await writeFile(s.file, 'dsh-do:\n  autoContinue:\n    maxContinuations: 4\n')
	await waitFor(() => s.read().autoContinue.maxContinuations === 4, 'the valid edit')
	await writeFile(s.file, 'dsh-do:\n  autoContinue:\n    maxContinuations: 0\n')
	// Give the watcher time to see and reject it.
	await new Promise((resolve) => setTimeout(resolve, 600))
	assert.equal(s.read().autoContinue.maxContinuations, 4, 'a value the schema refuses never reaches the plugin')
})

test('/do-config writes the file and keeps unrelated sections', { skip: lane }, async (t) => {
	const s = await stack(t)
	const out = await s.run('modelFallback.candidates deepseek/deepseek-chat, openai/gpt-4o')
	assert.equal(out.ok, true, out.lines.join('\n'))
	assert.equal((await s.run('modelFallback.enabled on')).ok, true)
	await waitFor(() => s.read().modelFallback.enabled === true, 'the command write to apply')
	const text = await readFile(s.file, 'utf8')
	assert.match(text, /dsh-do:/)
	assert.match(text, /openai\/gpt-4o/)
	assert.match(text, /other-plugin:\s*\n\s+keep: me/, 'another plugin\'s section is untouched')

	assert.equal((await s.run('reset modelFallback.enabled')).ok, true)
	await waitFor(() => s.read().modelFallback.enabled === false, 'the reset to apply')
	assert.equal((await s.run('autoContinue.maxContinuations 0')).ok, false, 'an out-of-range value is refused before writing')
})
