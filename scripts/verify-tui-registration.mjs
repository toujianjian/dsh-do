/**
 * 真实 TUI 注册表 × 真实 Cordis × 真实插件代码：验证 `/loop` 真的能注册进去。
 *
 * 为什么单独有这个脚本：`test/tui.test.mjs` 用的是自己写的 fakeRegistry，只能
 * 证明"我们按契约调用"。契约本身（register 校验、resolve 的最小唯一前缀、hint
 * 的展示文本）来自第三方 TUI 包 `@huiliyi37/dsh-tianshu-tui`，它不在本仓库的
 * 依赖里，所以没法写进 `node --test` 的测试集。这个脚本用**已安装的真实 TUI
 * 包**导出的 `SlashCommandRegistry` 顶上，把那一环补上。
 *
 *   node scripts/verify-tui-registration.mjs [TUI 包的 lib/index.js 路径]
 *
 * 不给参数时用本机 tui profile 的安装路径。退出码 0 = 全部通过。
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { LoopController } from '../lib/types/controller.js'
import { installTuiCommand, TUI_COMMANDS_SERVICE, TUI_LOOP_COMMAND_NAME } from '../lib/types/tui.js'

const positional = process.argv.slice(2).find((arg) => !arg.startsWith('--'))
const target = positional ?? join(
	homedir(), '.dsh', 'profiles', 'tui', 'node_modules', '@huiliyi37', 'dsh-tianshu-tui', 'lib', 'index.js',
)

if (!existsSync(target)) {
	console.error(`找不到 TUI 包：${target}\n用法：node scripts/verify-tui-registration.mjs [TUI 包的 lib/index.js 路径]`)
	process.exit(2)
}

const { SlashCommandRegistry } = await import(pathToFileURL(target).href)
assert.equal(typeof SlashCommandRegistry, 'function', 'TUI 包未导出 SlashCommandRegistry')

const logger = { info() {}, warn() {} }
const controller = new LoopController(undefined, logger)
const ctx = new Context()
// 插件里 agents 是硬 inject，run 时会查；裸 Context 得先告诉它。
ctx.provide('agents', { get: () => undefined })

installTuiCommand(ctx, controller, () => 7)
await Promise.resolve()

// 服务还没出现：web / headless 就是这个状态，必须什么都不发生。
const registry = new SlashCommandRegistry()
assert.equal(registry.list().length, 0, '服务未出现时不应注册任何命令')

// TUI 在构造时 provide 自己的注册表，挂起的 inject 此刻激活。
ctx.provide(TUI_COMMANDS_SERVICE, registry)
await Promise.resolve()
await Promise.resolve()

const names = registry.list().map((command) => command.name)
assert.deepEqual(names, [TUI_LOOP_COMMAND_NAME], `注册表里应是 /loop，实际 ${JSON.stringify(names)}`)

// 注册表按名精确取命令，TUI 执行斜杠命令走的就是这条。
const registered = registry.get(TUI_LOOP_COMMAND_NAME)
assert.ok(registered, '按名取不到 /loop')
assert.equal(typeof registered.run, 'function')
assert.equal(typeof registered.description, 'string')
assert.match(registered.argsHint, /pause/)

// 最小唯一前缀解析：TUI 允许 `/lo` 命中 `/loop`。
const resolved = registry.resolve('/lo 5m ship it')
assert.ok(resolved, '前缀解析 /lo 未命中')
assert.equal(resolved.command.name, TUI_LOOP_COMMAND_NAME)
assert.equal(resolved.text, '5m ship it')

// 内联提示行（输入 `/` 后在输入框上方显示的那行）。
assert.match(registry.hint('/lo') ?? '', /\/loop/)

// 真跑一次：命令必须驱动同一个 controller，和模型侧工具走的是同一份状态。
const echoed = []
await registered.run({ text: '5m ship it', echo: (line) => echoed.push(line), sessionId: 'live' })
const loop = controller.get('live')
assert.equal(loop.objective, 'ship it')
assert.equal(loop.intervalMs, 300_000)
assert.equal(loop.maxRounds, 7)
assert.match(echoed.at(-1), /Loop started/)

// 无会话时是提示而非抛错（TUI 可以在会话挂上前就敲斜杠命令）。
await registered.run({ text: 'go', echo: (line) => echoed.push(line), sessionId: null })
assert.match(echoed.at(-1), /^⚠ 当前无会话/)

// 卸载插件不留幽灵命令。
await ctx.fiber.dispose()
assert.equal(registry.list().length, 0, '卸载后 /loop 仍在注册表里')

console.log(`PASS  真实 TUI 注册表（${target}）`)
console.log('      /loop 注册、按名取用、前缀解析 /lo、内联提示、驱动 controller、卸载清理 全部符合契约')
