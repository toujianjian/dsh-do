/**
 * Producer-owned message sources.
 *
 * DSH 0.2.0 (session format v4) refuses the retired catch-all
 * `{ kind: 'plugin', plugin }` wrapper at encode time. Every notice this plugin
 * injects rides that path, so a single wrong kind silently disabled the loop's
 * pause announcement, its output-limit auto-continuation, the repeated-call
 * correction, and the `loop_done`/`loop_cancel` wrap-up — and failed the turn
 * that carried them. These tests pin the contract that keeps all of them
 * admissible, and they fail against the retired wrapper.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONTEXT_SUMMARY_MAX_CHARS } from '@deepseek-ai/dsh-llm'
import { DO_SOURCE_KIND, doNoticeSource, isDoSource } from '../lib/types/source.js'

/** The wrapper DSH retired: what this plugin used to stamp on every notice. */
const retiredSource = { kind: 'plugin', plugin: 'dsh-do', form: 'notice', summary: 'dsh-do loop paused: agent-error' }

/**
 * The documented admission rule, applied without the v4 package so the
 * assertion holds on 0.1.x too: a durable source kind must be a non-empty
 * string that is not the retired catch-all, and the retired `plugin` field must
 * be gone.
 */
function admittedByDocumentedRule(source) {
	return typeof source?.kind === 'string' && source.kind.length > 0 && source.kind !== 'plugin' && !('plugin' in source)
}

/** A durable `user/message` row as the session log frames it. */
const row = (source) => ({ type: 'user/message', seq: 1, data: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'x' }], source } })

test('a notice carries this plugin\'s own kind, not the retired wrapper', () => {
	const source = doNoticeSource('dsh-do loop paused: agent-error')
	assert.deepEqual(source, { kind: 'dsh-do', form: 'notice', summary: 'dsh-do loop paused: agent-error' })
	assert.equal(DO_SOURCE_KIND, 'dsh-do')
	// The control: the shape this plugin shipped before the fix is refused by the
	// rule every DSH 0.2.x session log enforces.
	assert.equal(admittedByDocumentedRule(retiredSource), false)
	assert.equal(admittedByDocumentedRule(source), true)
})

test('a notice summary is bounded to the durable-log limit', () => {
	const source = doNoticeSource('x'.repeat(CONTEXT_SUMMARY_MAX_CHARS * 3))
	assert.ok(source.summary.length <= CONTEXT_SUMMARY_MAX_CHARS, `summary kept ${source.summary.length} chars`)
})

test('isDoSource recognises live and migrated sources only', () => {
	assert.equal(isDoSource(doNoticeSource('x')), true)
	// What DSH's own v3→v4 migration writes when it lifts the released wrapper.
	assert.equal(isDoSource({ kind: 'plugin:dsh-do', form: 'notice' }), true)
	assert.equal(isDoSource(retiredSource), false)
	assert.equal(isDoSource({ kind: 'loop', loopId: 'l', round: 1 }), false)
	assert.equal(isDoSource({ kind: 'user' }), false)
	assert.equal(isDoSource(undefined), false)
	assert.equal(isDoSource(null), false)
	assert.equal(isDoSource('dsh-do'), false)
})

test('the real format-v4 gate admits a notice and refuses the retired wrapper', async (t) => {
	let admission
	try {
		// Present only where the runtime is 0.2.x; the repo's own devDependencies
		// resolve 0.1.x, which has no admission gate to exercise.
		;({ assertV4RowAdmission: admission } = await import('@deepseek-ai/dsh-session-format-v3-to-v4'))
	} catch {
		t.skip('@deepseek-ai/dsh-session-format-v3-to-v4 is not installed (0.1.x runtime)')
		return
	}
	admission(row(doNoticeSource('dsh-do loop paused: agent-error')))
	admission(row({ kind: 'loop', loopId: 'l', round: 1 }))
	assert.throws(() => admission(row(retiredSource)), /producer-owned source kind/)
})

test('no built module stamps the retired plugin wrapper', () => {
	const dir = fileURLToPath(new URL('../lib/', import.meta.url))
	const offenders = []
	const visit = (path) => {
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const full = join(path, entry.name)
			if (entry.isDirectory()) visit(full)
			else if (entry.name.endsWith('.js')) {
				// The wrapper's tell-tale is its `plugin` field holding the plugin
				// name; the retired `kind` alone also appears in documentation.
				if (/plugin:\s*['"]dsh-do['"]/.test(readFileSync(full, 'utf8'))) offenders.push(full)
			}
		}
	}
	visit(dir)
	assert.deepEqual(offenders, [], 'these modules still stamp the retired plugin wrapper')
})
