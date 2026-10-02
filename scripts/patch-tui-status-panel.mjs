/**
 * Patch the installed dsh-tianshu-tui so its /status panel renders a loop
 * section from dsh-do's `loops` service (and the `loop` session projection).
 *
 * The TUI's panel is hard-coded to goal/todos/plan, so a newly registered
 * projection key is invisible until the panel learns about it. This applies the
 * four minimal edits (section renderer, panel assembly, snapshot field, call
 * site). Idempotent: re-running is a no-op. Run with --check to verify only.
 *
 * Archive note — the earlier revision read the `loop` session projection and
 * assumed it carried `objective`/`phase`/`armed`/`maxRounds`. It does not: a
 * projection cell is a pure fold over the session log, so `view` returns only
 * `{loopId, roundsStarted, lastRoundAt}`. Rendering `loop.objective` therefore
 * fed `undefined` into the truncator and threw inside a render timer, taking the
 * whole TUI process down the first time a loop was running and `/status` opened.
 * Live fields come from the `loops` service, exactly like `tasks`/`subagents`.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const DEFAULT_TARGET = 'C:\\Users\\Huawei\\.dsh\\profiles\\tui\\node_modules\\@huiliyi37\\dsh-tianshu-tui\\lib\\index.js'
// Flags must be filtered out before picking the positional target, or
// `patch-tui-status-panel.mjs --check` would look for a bundle named `--check`.
const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const target = args.find((arg) => !arg.startsWith('--')) ?? DEFAULT_TARGET
if (!existsSync(target)) {
	console.error(`tui bundle not found: ${target}`)
	process.exit(2)
}

let source = readFileSync(target, 'utf8')
const applied = []
const already = []

/**
 * Apply one exact-text patch, recording whether it was needed. In check mode the
 * text is never mutated, so the summary reports the file's real state instead of
 * counting what this run would have changed.
 */
function patch(label, from, to, { optional = false } = {}) {
	// The target text is tested FIRST: `to` deliberately contains `from` for the
	// renderer and snapshot edits, so testing `from` alone would re-inject the
	// block on every run and duplicate the declaration.
	if (source.includes(to)) {
		already.push(label)
		return
	}
	if (!source.includes(from)) {
		if (optional) return
		console.error(`FAILED ${label}: anchor not found`)
		process.exit(3)
	}
	if (checkOnly) {
		applied.push(label)
		return
	}
	source = source.replace(from, to)
	applied.push(label)
}

const PLAN_ANCHOR = '/** 计划段：active/pending 徽标单行。 */'

// Renders the loop section from dsh-do's `loops` service view. Every field is
// treated as optional: a throw here happens inside the render timer and kills
// the TUI process, so the section must degrade instead of failing.
const NEW_RENDERER = `/** 循环段标题行（dsh-do 的 loops 服务视图）。 */
const LOOP_TITLE = "◆ 循环";
/**
* 循环段：状态行 + 目标 + 轮次；暂停时给出原因，使「循环停了」不再无声。
* 视图字段一律按可选处理——渲染期抛错会连带打死整个 TUI 进程。
* @param loop - dsh-do 的 loops 服务视图；null → 该段不渲染。
* @param width - 行截断宽度预算。
* @returns 面板行数组。
*/
function projectLoopSection(loop, width) {
	const rows = [];
	const asText = (value, fallback) => typeof value === "string" && value.length > 0 ? value : fallback;
	const phase = loop.phase === "active" ? loop.armed === true ? "进行中" : "已暂停" : "已结束";
	rows.push(truncateByWidth$4(\`\${LOOP_TITLE} · \${phase}\`, width));
	rows.push(truncateByWidth$4(asText(loop.objective, "(无目标)"), width));
	const rounds = Number.isFinite(loop.roundsStarted) ? loop.roundsStarted : 0;
	const maxRounds = Number.isFinite(loop.maxRounds) ? loop.maxRounds : "?";
	rows.push(truncateByWidth$4(\`↻ 轮次 \${rounds}/\${maxRounds}\`, width));
	const paused = loop.pausedReason;
	if (paused !== void 0 && paused !== null) rows.push(truncateByWidth$4(\`⏸ \${asText(paused.code, "paused")} · \${asText(paused.message, "")}\`, width));
	return rows;
}
${PLAN_ANCHOR}`

// The revision that shipped before this one, kept only so an already-patched
// install can be upgraded in place instead of reinstalled.
const OLD_RENDERER = `/** 循环段标题行（dsh-do 插件注册的 loop 投影）。 */
const LOOP_TITLE = "◆ 循环";
/**
* 循环段：状态行 + 目标 + 轮次；暂停时给出原因，使「循环停了」不再无声。
* @param loop - dsh-do 的 loop 投影快照；null → 该段不渲染。
* @param width - 行截断宽度预算。
* @returns 面板行数组。
*/
function projectLoopSection(loop, width) {
	const rows = [];
	const status = loop.armed ? "进行中" : "已暂停";
	const phase = loop.phase === "active" ? status : "已结束";
	rows.push(truncateByWidth$4(\`\${LOOP_TITLE} · \${phase}\`, width));
	rows.push(truncateByWidth$4(loop.objective, width));
	rows.push(truncateByWidth$4(\`↻ 轮次 \${loop.roundsStarted}/\${loop.maxRounds}\`, width));
	if (loop.pausedReason !== void 0) rows.push(truncateByWidth$4(\`⏸ \${loop.pausedReason.code} · \${loop.pausedReason.message}\`, width));
	return rows;
}
${PLAN_ANCHOR}`

const NEW_SNAPSHOT_LINE = '\t\t\tloop: this.ctx.reflect.get("loops", false)?.list?.().get(String(this.activeSessionId)) ?? null,'
const OLD_SNAPSHOT_LINE = '\t\t\tloop: this.projectionCache?.loop ?? null,'
const OLD_SNAPSHOT_BLOCK = `			goal: this.projectionCache?.goal ?? null,
			todos: this.projectionCache?.todos ?? null,
			plan: this.projectionCache?.plan ?? null,`

// 1b. Upgrade an install patched by the previous revision. Runs before the base
// edits: their `to` text still contains the old anchor, so an upgrade must land
// first or the base edit would append a second copy beside the old one.
patch('section renderer upgrade', OLD_RENDERER, NEW_RENDERER, { optional: true })

// 1. A loop section renderer beside the goal one.
patch('section renderer', PLAN_ANCHOR, NEW_RENDERER)

// 2. Fold the loop section into the panel assembly.
patch(
	'panel assembly',
	`function projectStatusPanel(goal, todos, plan, opts) {
	const rows = [];
	if (goal !== null) rows.push(...projectGoalSection(goal, opts.width));`,
	`function projectStatusPanel(goal, todos, plan, opts, loop = null) {
	const rows = [];
	if (loop !== null) rows.push(...projectLoopSection(loop, opts.width));
	if (goal !== null) rows.push(...projectGoalSection(goal, opts.width));`,
)

// 3. Pass the snapshot's loop view through. The call site has two shapes in the
// wild: 0.1.1-rc.6 passes a one-line options object, while 0.1.2-rc.31 and
// 1.0.0-rc.2 spread it across lines and add `sessionTotals`. Both are handled;
// a future shape change trips the REQUIRED check below instead of silently
// wiring nothing.
const CALL_LEGACY_FROM = 'return projectStatusPanel(snapshot.goal, snapshot.todos ?? [], snapshot.plan, { width: snapshot.cols });'
const CALL_LEGACY_TO = 'return projectStatusPanel(snapshot.goal, snapshot.todos ?? [], snapshot.plan, { width: snapshot.cols }, snapshot.loop ?? null);'
const CALL_MODERN_FROM = `	const rows = projectStatusPanel(snapshot.goal, snapshot.todos ?? [], snapshot.plan, {
		width: snapshot.cols,
		sessionTotals: snapshot.sessionTotals
	});`
const CALL_MODERN_TO = `	const rows = projectStatusPanel(snapshot.goal, snapshot.todos ?? [], snapshot.plan, {
		width: snapshot.cols,
		sessionTotals: snapshot.sessionTotals
	}, snapshot.loop ?? null);`

patch('call site (one-line options)', CALL_LEGACY_FROM, CALL_LEGACY_TO, { optional: true })
patch('call site (spread options)', CALL_MODERN_FROM, CALL_MODERN_TO, { optional: true })

// 4b. Upgrade an install patched by the previous revision (same reason as 1b).
patch('snapshot field upgrade', OLD_SNAPSHOT_LINE, NEW_SNAPSHOT_LINE, { optional: true })

// 4. Expose the loop view on the render snapshot, read from the `loops` service.
patch('snapshot field', OLD_SNAPSHOT_BLOCK, `${OLD_SNAPSHOT_BLOCK}\n${NEW_SNAPSHOT_LINE}`)

// The markers that prove every edit landed. The call-site marker matters most:
// its two variants are both optional, so without it an unrecognised future
// shape would pass unnoticed and the section would simply never receive data.
const REQUIRED = [
	['guarded loop renderer', 'const asText = (value, fallback) =>'],
	['loops service lookup', 'reflect.get("loops", false)?.list?.().get(String(this.activeSessionId))'],
	['panel call site', '}, snapshot.loop ?? null);'],
	['panel assembly', 'function projectStatusPanel(goal, todos, plan, opts, loop = null) {'],
]

console.log('applied :', applied.length ? applied.join(', ') : '(none)')
if (already.length) console.log('already :', already.join(', '))

const missing = REQUIRED.filter(([, marker]) => !source.includes(marker)).map(([label]) => label)
if (checkOnly) {
	const ok = missing.length === 0 && applied.length === 0
	if (!ok) console.error(`missing: ${missing.join(', ') || '(none)'}${applied.length ? ` — ${applied.length} edit(s) still pending` : ''}`)
	console.log(ok ? 'CHECK: patched' : 'CHECK: NOT patched')
	process.exit(ok ? 0 : 1)
}
if (missing.length) {
	console.error(`FAILED: ${missing.join(', ')} missing after patching`)
	process.exit(4)
}
if (applied.length > 0) {
	writeFileSync(target, source)
	console.log('written :', target)
} else {
	console.log('no change needed')
}
