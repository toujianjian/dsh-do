/**
 * Patch the installed dsh-tianshu-tui so its /status panel renders a loop
 * section from the `loop` session projection that dsh-do registers.
 *
 * The TUI's panel is hard-coded to goal/todos/plan, so a newly registered
 * projection key is invisible until the panel learns about it. This applies the
 * four minimal edits (section renderer, panel assembly, snapshot field, call
 * site). Idempotent: re-running is a no-op. Run with --check to verify only.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const target = process.argv[2] ?? 'C:\\Users\\Huawei\\.dsh\\profiles\\tui\\node_modules\\@huiliyi37\\dsh-tianshu-tui\\lib\\index.js'
const checkOnly = process.argv.includes('--check')
if (!existsSync(target)) {
	console.error(`tui bundle not found: ${target}`)
	process.exit(2)
}

let source = readFileSync(target, 'utf8')
const applied = []
const skipped = []

/**
 * Apply one exact-text patch, recording whether it was needed. In check mode the
 * text is never mutated, so the summary reports the file's real state instead of
 * counting what this run would have changed.
 */
function patch(label, from, to) {
	if (!source.includes(from)) {
		if (checkOnly || source.includes(to)) skipped.push(label)
		else {
			console.error(`FAILED ${label}: anchor not found`)
			process.exit(3)
		}
		return
	}
	if (checkOnly) {
		skipped.push(label)
		return
	}
	source = source.replace(from, to)
	applied.push(label)
}

// 1. A loop section renderer beside the goal one.
patch(
	'section renderer',
	'/** 计划段：active/pending 徽标单行。 */',
	`/** 循环段标题行（dsh-do 插件注册的 loop 投影）。 */
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
/** 计划段：active/pending 徽标单行。 */`,
)

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

// 3. Pass the snapshot's loop projection through.
patch(
	'call site',
	'return projectStatusPanel(snapshot.goal, snapshot.todos ?? [], snapshot.plan, { width: snapshot.cols });',
	'return projectStatusPanel(snapshot.goal, snapshot.todos ?? [], snapshot.plan, { width: snapshot.cols }, snapshot.loop ?? null);',
)

// 4. Expose the loop projection on the render snapshot.
patch(
	'snapshot field',
	`			goal: this.projectionCache?.goal ?? null,
			todos: this.projectionCache?.todos ?? null,
			plan: this.projectionCache?.plan ?? null,`,
	`			goal: this.projectionCache?.goal ?? null,
			todos: this.projectionCache?.todos ?? null,
			plan: this.projectionCache?.plan ?? null,
			loop: this.projectionCache?.loop ?? null,`,
)

console.log('applied :', applied.length ? applied.join(', ') : '(none)')
if (skipped.length) console.log('already :', skipped.join(', '))
if (checkOnly) {
	const ok = applied.length === 0 && skipped.length === 4
	console.log(ok ? 'CHECK: patched' : 'CHECK: NOT patched')
	process.exit(ok ? 0 : 1)
}
if (applied.length > 0) {
	writeFileSync(target, source)
	console.log('written :', target)
} else {
	console.log('no change needed')
}
