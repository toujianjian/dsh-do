/**
 * Regression guard for scripts/patch-tui-status-panel.mjs.
 *
 * The first shipped revision of the patch read the `loop` session projection and
 * assumed it carried `objective`/`phase`/`armed`/`maxRounds`. A projection cell
 * is a pure fold over the session log, so its `view` returns only
 * `{loopId, roundsStarted, lastRoundAt}`. Rendering `loop.objective` therefore
 * fed `undefined` into the truncator, which throws while iterating, and because
 * the call happens inside a render timer the exception killed the whole TUI
 * process — the first time a loop was running and `/status` was opened.
 *
 * These tests patch a minimal fixture that reproduces the real anchors, then
 * execute the injected renderer against both the true projection shape and a
 * fully-populated service view.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const patcher = join(repoRoot, 'scripts', 'patch-tui-status-panel.mjs')

/** Three tabs, matching the real bundle's indentation exactly. */
const SNAPSHOT_BLOCK = [
	'\t\t\tgoal: this.projectionCache?.goal ?? null,',
	'\t\t\ttodos: this.projectionCache?.todos ?? null,',
	'\t\t\tplan: this.projectionCache?.plan ?? null,',
].join('\n')

/**
 * A minimal stand-in for the TUI bundle: it carries the four anchor sites the
 * patcher edits, and a `truncateByWidth$4` that fails on non-strings exactly the
 * way the real one does.
 */
const FIXTURE = `function truncateByWidth$4(text, width) {
	let out = "";
	for (const ch of text) {
		if (out.length >= width) break;
		out += ch;
	}
	return out;
}
/** 计划段：active/pending 徽标单行。 */
function projectGoalSection(goal, width) {
	return [truncateByWidth$4(goal.objective, width)];
}
function projectStatusPanel(goal, todos, plan, opts) {
	const rows = [];
	if (goal !== null) rows.push(...projectGoalSection(goal, opts.width));
	return rows;
}
function renderStatusPanel(snapshot) {
	return projectStatusPanel(snapshot.goal, snapshot.todos ?? [], snapshot.plan, { width: snapshot.cols });
}
class App {
	constructor(ctx) {
		this.ctx = ctx;
		this.projectionCache = null;
		this.activeSessionId = "session-1";
	}
	snapshot(cols) {
		return {
			cols,
${SNAPSHOT_BLOCK}
		};
	}
}
export { projectLoopSection, App, renderStatusPanel };
`

/**
 * Patch a fresh fixture in a temp dir and import the result.
 * @returns the imported module plus the temp dir for cleanup.
 */
function patchedFixture() {
	const dir = mkdtempSync(join(tmpdir(), 'dsh-do-tui-patch-'))
	const file = join(dir, 'bundle.mjs')
	writeFileSync(file, FIXTURE)
	const out = execFileSync(process.execPath, [patcher, file], { encoding: 'utf8' })
	assert.match(out, /written/, `patcher did not write the fixture:\n${out}`)
	return { dir, file, mod: import(pathToFileURL(file).href) }
}

test('patcher injects a guarded loop renderer and a loops-service lookup', async () => {
	const { dir, file, mod } = patchedFixture()
	try {
		const source = readFileSync(file, 'utf8')
		assert.match(source, /const asText = \(value, fallback\) =>/)
		assert.match(source, /reflect\.get\("loops", false\)/)
		assert.doesNotMatch(source, /projectionCache\?\.loop/)
		const check = execFileSync(process.execPath, [patcher, file, '--check'], { encoding: 'utf8' })
		assert.match(check, /CHECK: patched/)
		await mod
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test('patcher is idempotent: a second run changes nothing', () => {
	const { dir, file } = patchedFixture()
	try {
		const before = readFileSync(file, 'utf8')
		const out = execFileSync(process.execPath, [patcher, file], { encoding: 'utf8' })
		assert.match(out, /no change needed/)
		assert.equal(readFileSync(file, 'utf8'), before)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test('a leading flag is not mistaken for the target path', async () => {
	const { dir, file, mod } = patchedFixture()
	try {
		await mod
		const check = execFileSync(process.execPath, [patcher, '--check', file], { encoding: 'utf8' })
		assert.match(check, /CHECK: patched/)
		assert.doesNotMatch(check, /bundle not found/)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test('loop renderer survives the real projection shape that crashed the TUI', async () => {
	const { dir, mod } = patchedFixture()
	try {
		const { projectLoopSection } = await mod
		// The exact shape a `loop` projection cell holds — no objective, no phase.
		const projectionState = { loopId: 'loop-1', roundsStarted: 1, lastRoundAt: null }
		const rows = projectLoopSection(projectionState, 60)
		assert.ok(Array.isArray(rows) && rows.length >= 3)
		assert.match(rows[0], /◆ 循环/)
		assert.match(rows[1], /\(无目标\)/)
		assert.match(rows[2], /↻ 轮次 1\/\?/)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test('loop renderer tolerates an entirely empty view', async () => {
	const { dir, mod } = patchedFixture()
	try {
		const { projectLoopSection } = await mod
		for (const bad of [{}, { objective: null }, { objective: 42, maxRounds: 'x', roundsStarted: NaN }]) {
			assert.doesNotThrow(() => projectLoopSection(bad, 60), `threw for ${JSON.stringify(bad)}`)
		}
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test('loop renderer reports the live service view, pause reason included', async () => {
	const { dir, mod } = patchedFixture()
	try {
		const { projectLoopSection } = await mod
		const running = projectLoopSection({ phase: 'active', armed: true, objective: '修好循环段', roundsStarted: 2, maxRounds: 20 }, 60)
		assert.match(running[0], /◆ 循环 · 进行中/)
		assert.equal(running[1], '修好循环段')
		assert.match(running[2], /↻ 轮次 2\/20/)

		const paused = projectLoopSection({
			phase: 'active',
			armed: false,
			objective: '修好循环段',
			roundsStarted: 1,
			maxRounds: 20,
			pausedReason: { code: 'agent-error', message: 'the agent reported an error' },
		}, 80)
		assert.match(paused[0], /◆ 循环 · 已暂停/)
		const reason = paused.find((row) => row.includes('⏸'))
		assert.match(reason, /agent-error · the agent reported an error/)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test('snapshot reads the loops service for the active session, not the projection', async () => {
	const { dir, mod } = patchedFixture()
	try {
		const { App } = await mod
		const view = { phase: 'active', armed: true, objective: '目标', roundsStarted: 3, maxRounds: 20 }
		const seen = []
		const app = new App({
			reflect: {
				get: (name, required) => {
					seen.push([name, required])
					return name === 'loops' ? { list: () => new Map([['session-1', view]]) } : undefined
				},
			},
		})
		assert.equal(app.snapshot(80).loop, view)
		assert.deepEqual(seen, [['loops', false]])
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})
