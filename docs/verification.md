# 验证记录

## 第八轮（重试配置的真实读写语义：用真 schema 验证，推翻我自己的三条假设）

目标 (a)：`llm-pi-ai` 嵌套 `retryPolicy` 的真实读写。新增 `test/retry-policy-real.test.mjs`（8 条真实依赖用例），把真实服务的 `settings` 与**真实的 `RetryPolicySchema`**（从运行时 `@deepseek-ai/dsh-llm` 导入，非手写）组合起来。

### 被真实依赖推翻的三条假设（都是我的错，不是产品缺陷）

1. **以为退避参数是 schema 字段。** 真实 `RetryPolicySchema` 只带 `maxRetries`、`retryableCodes` 与 `mode`；`initialDelayMs` / `maxDelayMs` / `jitterRatio` 是 `resolveRetryPolicy()` 在适配器解析时补的，**不在 section schema 里**。
2. **以为用户层不写 `mode` 就会被拒。** 实际 section 解析是**「组合条目 base + 用户层」叠加**：只要 base 已带 `mode`，用户层写半截对象照样解析成功。
3. **以为"必须整对象写入"是普遍约束。** 它只在**base 未提供 `retryPolicy`** 时才成立——那时没有任何层能补出必需的判别字段，半截写入才被拒。

### 得到证实的结论

- **路径级写入保留兄弟字段**：对真实的 union schema，`providers.<id>.retryPolicy.maxRetries` 这样写下去，`mode` 与 `retryableCodes` 都原样保留（`applyPathOp` 逐层 spread）。同一个 revision-fenced 请求里连写多个叶子也成立。
- **`mode` 确为必需且是 `const`**：`{maxRetries:3}`（无 mode）且 base 无 policy 时被拒；未知 mode 被拒；`unset mode` 在无 base 兜底时被拒。
- **`RetryPolicySchema = z.union([normal, always])`**：`always` 分支是独立成员且**不含 `retryableCodes`**，页面可切换。
- 这些拒绝都不是 `SETTINGS_CONFLICT`——与第六轮的状态码分类自洽。

### 工具坑（已记入记忆）

用 `Promise.all` 并发 `import()` 运行时模块会触发 `ERR_REQUIRE_ESM_RACE_CONDITION`（cosmokit "not yet fully loaded"）；改成**顺序加载**即可。

### 复测

- `npm test`：**143 用例 / 143 通过 / 0 失败 / 0 跳过**（本轮 +8）。
- `lib/` 已随完整构建同步。本轮**无产品代码改动**，仅新增验证与文档。

## 第七轮（循环为何"自己停了"：查证为官方契约，非缺陷）

**现象**：重启后检查点显示 `loop-198697e0 | phase=active | armed=false | rounds=1/12`，且写入时间 **19:58:53 不在任何重启边界上**——是运行期被 disarm 的。`armed=false` 意味着循环**不会自行继续**。

**查证方法**：①逐行比对官方 `dsh-goal-round-driver` 的 disarm 触发点；②解压真实会话日志取 `turn/end` 的 `reason`。

**结论：与官方契约逐行一致，不是本插件的偏差。** 官方驱动对 turn/end 的处理是：

```js
case "turn/end":
    if (event.data.reason.kind === "max-tokens") { disarm(state); return; }   // ← 与本插件相同
    if (event.data.reason.kind !== "aborted") return;
    if (state.attempt?.phase === "claimed" || state.attempt?.phase === "admitted") state.attempt.cancelled = true;
    else disarm(state);
```

真实日志（12441 帧 / 19650 事件）里 `turn/end` 共 30 次，其中 **`max-tokens` 出现 2 次**，另有多轮 `aborted`（`reason.kind: "user"`，即真人插话接管）。admitted 的 loop 轮次恰好 2 个（`loop-ab9b7d6d` round 1、`loop-198697e0` round 1），与实测吻合。因此 `armed=false` 是**"长回合撞 max-tokens / 真人接管"按设计暂停**的结果。

**故本轮不改动驱动语义**——改了就会与官方 goal 的行为分叉。

### 由此暴露的一个真实体验缺口（待用户决定）

循环被暂停后**没有任何面向用户的提示**：检查点里 `armed=false`，用户必须主动敲 `/loop` 才知道它停了。而官方 goal 体系暂停的是 goal 对象，由 goal UI 显著展示。这是"长回合撞 max-tokens → 循环静默停止"的体验问题，属于**新增可见性**（例如暂停时输出一条提示），不是修既有缺陷——按规矩先报给用户定夺，未擅自实现。

### 工具教训（非产品缺陷）

会话日志 `session.jsonl.zstd` 是**多帧 zstd**（每次 append 一帧）。Node 的 `zstdDecompressSync` **只解第一帧**，直接整体解压只会得到 1 个事件，极易误判成"日志是空的/格式变了"。正确做法：按魔数 `28 B5 2F FD` 切帧后逐帧解压（本轮 1 → 12441 帧）。

## 第六轮（用真实依赖替代假服务，暴露设置路由两个真实缺陷）

方法：不再依赖手写假服务，而是**挂载出厂的文件 provider**（`@deepseek-ai/dsh-settings-file`，与 web profile 实际运行的同一张依赖图），让被测的 `mutate` / `applyPathOp` / revision 围栏 / schema 解析 / 失败机器码都是部署真正会跑的那一套。新增 `test/settings-real.test.mjs`（6 条），仅在设置 `DSH_COMPOSITION_RUNTIME_MANIFEST` 时实跑（沿用仓库既有的真实 Loader lane 约定）。

### 先读真实语义，再定判据

`dsh-settings` 的 `applyPathOp` 逐层 `{...section, [head]: …}` 递归 → **深层路径写入天然保留兄弟字段**（"不碰兄弟字段"这条主张由此首次得到实证，此前只是断言）。同时读出三条假服务从未模拟的契约：①空路径 `set` 是**整段替换**且**要求 plain object**，否则抛 `TypeError`；②revision 校验发生在**写入队列内部**；③只有原始段真的变化才 `bumpRevision`（无操作写入不涨版本）。

### 缺陷 1：解析器放过非对象根写入

`parseSettingsWriteRequest` 对空路径只检查 `'value' in op`，不管类型。而真实服务的 `applyPathOp` 对非 plain object 的根写入抛 `TypeError`。结果是**一个畸形请求以服务内部错误的形式冒出**，并被旧代码一律报成 409。注释里本就写着"requires a plain object"，代码却没实现——文档意图与实现不一致。

**修复**：解析器新增 `isPlainObjectValue`（拒绝标量、null、数组、类实例），对该情形返回 400 并给出面向请求本身的说明。

### 缺陷 2：所有写入失败一律 409

真实 `SettingsConflictError` 带一个**文档化的稳定机器码**：

```ts
readonly code = "SETTINGS_CONFLICT";   // "Stable machine code for wire layers mapping this to their own taxonomy"
```

上游明确说了这是给**线层**做分类用的，而旧路由把 `mutate` 的**任何**失败都报成 409——等于告诉页面"你的副本过期了，重新加载"，而真实原因可能是请求畸形、schema 拒绝、命名空间未注册或 provider 只读。

**修复**：按机器码分类——`code === 'SETTINGS_CONFLICT'` → 409；`TypeError`（op 形状 / 非 JSON 数据 / 根写入类型）→ 400；其余（未注册、已销毁、只读）→ 500。并**回显机器码**，让页面不必解析文案。

### 附带发现：假服务与真实契约的偏差（由红测暴露）

改完状态码后两条既有用例转红——因为**假服务的冲突错误没有 `code`**，按真实契约判定就成了 500。这正是本轮方法的意义：假服务掩盖了它自己没模拟的契约。已按真实语义修正假服务（补上 `SETTINGS_CONFLICT` 机器码），并把"未注册命名空间"的断言改为 500 且明确 `code` 为 undefined。

### 未改动（留待用户决定）

**写路径没有命名空间白名单**：读路径限定 `READ_NAMESPACES`，写路径把任何 `ns` 直接交给服务。因为同源策略已保护、且页面只写它读到过的命名空间，本轮未收紧（收紧属于设计变更）。若要与读路径对齐，可在解析器里限定 `ns ∈ READ_NAMESPACES`，那样"未注册命名空间"就会变成干净的 400。

### 复测

- `npm test`：**135 用例 / 135 通过 / 0 失败 / 0 跳过**（本轮 +7）。
- 双端 typecheck 干净；`lib/` 已随 `npm test` 的完整构建同步。
- **本轮改动尚未部署到 web profile**（部署需重启，会打断正在运行的验证循环）。

## 第五轮（真实使用发现的缺陷：`/loop` 建好循环但首轮不跑）

### 现象与证据

用户实际输入 `/loop 你看看，现在可以用了` 后反馈"没有开始"。磁盘检查点 `~/.dsh/loops/loop-<id>.json` 显示循环**创建成功**（`phase: active`、`armed: true`、`objective` 正确、`maxRounds: 20`、`intervalMs: 600000`），但 **`roundsStarted: 0`** —— 轮次从未被 admit。即：命令被处理了、循环看起来完全健康，却一轮都没跑。

### 根因

驱动的全部唤醒来源都是 **agent 生命周期事件**（`agent/status` 转 `idle`、inbox 变化、`session/event`、以及装载时对既有 agent 的一次性扫描）。而**执行斜杠命令不产生任何状态迁移**——命令"不发送给模型"，agent 本来就 idle、执行完仍然 idle，所以 `agent/status` 永远不会因这次操作而触发。同时 `LoopController.commit()` 只写检查点，**不通知任何人**。结果：新建的循环只能干等下一次与它无关的 idle 迁移（例如用户再发一条普通消息）才可能被驱动看到。

**官方对照（决定性证据）**：`@deepseek-ai/dsh-goal-round-driver` 的监听器清单里有一条本插件缺失的唤醒——`ctx.on("goal/changed", ({ agent }) => { …; requestDrive(state) })`（其 `readyToDrive` 与本插件逐条一致，同样强制 `status === "idle"`）。所以 `/goal` 能在命令执行后立刻起跑，正是靠这条信号。

**上游契约对照**：Claude Code 还原源码 `src/skills/bundled/loop.ts` 第 67 行明确写着 *"**Then immediately execute the parsed prompt now** — don't wait for the first cron fire."*。本插件的 interval 解析规则（前导 interval token、尾部 `every <N><unit>` 从句、默认 10m、"check every PR" 不算 interval）与它逐行一致，唯独这条"立即执行"契约没有被兑现。

### 修复

1. `src/controller.ts`：新增导出类型 `LoopChangeNotifier` 与 `setNotifier()`；`commit()` 在**仅当 `phase === 'active' && armed`** 时调用通知（终态与 pause 刻意静默）。通知抛错被捕获并记 warn，**绝不连累触发它的那次变更**。
2. `src/driver.ts`：`installLoopDriver` 改为返回 `LoopDriverHandle { nudge(sessionId) }`，内部把 sessionId 装成 `SessionId` 找活 agent 并 `requestDrive`。找不到 agent 时安全返回；驱动的 pass 会重读实时状态，循环未 armed/active 时自然不排队。
3. `src/index.ts`：装配期把 `controller.setNotifier` 接到 `driver.nudge`，并在 `yield` 的 teardown 里解绑，保证已销毁的驱动不会被后续变更调用。
4. `src/driver.ts`（同轮补的第二个缺口）：`agent/session-start` 时也 `requestDrive`。**重启恢复的循环不走 `commit()`**（`restore()` 直接写入注册表，不触发通知），而重启后 agent 是在插件装载**之后**才出现的，因此也错过装载期的追赶扫描——两处都够不着，恢复的 armed 循环会一直静默到某次无关的 idle 迁移。会话启动是最后一个能唤醒它的时机。

### 本轮新增测试（+5，共 127）

| 用例 | 锁定的契约 |
| --- | --- |
| starting a loop on an already-idle agent queues the first round at once | **修复本身**：驱动已装载后再 `start`，首个 round 立刻排队 |
| without the change sink the same start stays dormant (the reported failure) | **对照组**：不接通知时同一次 `start` 不排队、循环仍 armed —— 精确复现用户遇到的故障 |
| the controller notifies only for armed active loops | 通知时机：create/resume/edit 通知；pause、complete、cancel 静默 |
| a failing change sink never fails the mutation that caused it | 通知抛错时循环仍创建成功，且留下 warn |
| detaching the sink stops wakeups, so a disposed driver is never called | teardown 解绑有效 |

测试脚手架新增 `deferStart` / `wireNotifier` 两个选项：`deferStart` 复刻"驱动已装载、循环后创建"的真实顺序（默认顺序只覆盖装载时的追赶扫描）。

### 复测

- `npm test`（完整构建 + 真实 Loader + 真实 `CommandRuntime`）：**127 用例 / 127 通过 / 0 失败 / 0 跳过**。
- 双端 `tsc --noEmit` 干净。

### 有意保留的差异（对照 Claude Code）

- **裸 `/loop`**：Claude Code 打印 usage，本插件打印当前循环状态。保留本插件行为——需求是"像 `/goal` 那样用斜杠命令继续"，`/goal` 的裸调用正是显示状态。
- **调度模型**：Claude Code 的 `/loop` 是一个 skill，由**模型**解析后再调用 cron 工具（带 `DEFAULT_MAX_AGE_DAYS` 过期）；本插件由代码确定性解析、以"轮次间最小延迟"驱动（见第三轮设计决策），不引入 cron 与过期语义。

## 第四轮（本轮：`/loop` 节奏执行、TUI 兼容、真实 Loader 复验）

### 已通过

- `npm run typecheck`：Host 与 Client 双 `tsc --noEmit` 通过。
- `npm test`（完整构建 + `node --test test/*.test.mjs`）：**122 个用例，122 通过，0 失败，0 跳过**。
- **真实 Loader 用例已实跑**（本轮首次）：设置 `DSH_COMPOSITION_RUNTIME_MANIFEST` 为本机 DSH 的 `package.json` 后，`test/composition.test.mjs` 的 `installed Loader mounts the single bundle row and removes it cleanly` 由跳过转为通过——真实 `cordis-plugin-loader` 挂载本插件的唯一 `insert` 行，断言 entry fiber 达到 ACTIVE、注册与卸载都干净、且 `ctx.get('webServer') === undefined`。累计 0 跳过。
- **真实 `CommandRuntime` 用例**：`/loop` 的注册不再只由手写假 registry 覆盖，而是挂载真实的 `@deepseek-ai/dsh-commands`，经真实 `normalizeDefinition` 校验、`list()`/`find()` 解析、并以真实 `CommandInvocation` 形状驱动 handler；同时断言卸载插件会**释放命令名**（否则重载会重复注册或留下绑死已销毁 controller 的陈旧 handler）。
- 基线对比：47（初始）→ 50（审计轮）→ 98（第三轮）→ 121（节奏与 TUI）→ **122**（本轮）。
- 单一插件约束仍然成立：`cordis.patch.yml` 仍只有一条 `insert`，`id: do` / `name: dsh-do`，由 `test/package.test.mjs` 断言；真实 Loader 用例再次确认该行能独立挂载并卸载。
- 构建产物已同步：`lib/`、`lib/types/`、`lib/client.js` 均由本轮源码重新生成。
- 本轮构建哈希：Host `lib/index.js` = `C9B45224565257D7DFB94D795C0B7C710D0C1A42CBD3CA21D75F9CEBD62BED6A`（Host 半是确定性构建，多次重建同哈希）；Client `lib/client.js` 每次重建都会变，见"发现：客户端构建非确定性"。

### TUI（`dsh-tui`）组合验证

`dsh-tui` 即 `@huiliyi37/dsh-tianshu-tui` v0.1.1-rc.6，profile 位于 `~/.dsh/profiles/tui`，组成 = `@deepseek-ai/dsh-base` + `@huiliyi37/dsh-tianshu-tui`（只 insert 一行 `tui-runner`）。

- 把本轮 tarball 装入该 profile 后 `dsh --profile tui --dump-config` 输出同时包含 `- id: tui-runner / name: '@huiliyi37/dsh-tianshu-tui'` 与 **唯一的** `- id: do / name: dsh-do`（`config` 为 `defaultMaxRounds: 20 / checkpointDir: '' / persist: true`）。
- 该 profile 提供 `agents` / `tools` / `systemPrompt` / `commands` / `settings` / `compaction`，**没有 `webServer`** —— 因此 dsh-do 的硬注入与各可选门控全部满足，Web 专属的 `/dsh-do/settings` 路由正确地不安装。
- 组合打印不等于运行期行为：TUI 内的 `/loop` 实际交互仍须人工在 TTY 里验收（见"尚未声称完成"）。

### 本轮发现并修复的真实缺陷

1. **`intervalMs` 只被解析、持久化与展示，驱动从不执行它**（`src/driver.ts`）：`/loop 5m <obj>` 与状态行都宣称"every 5m"，但驱动会在每轮空闲后立即续排下一轮，等于界面在说谎，且"有节奏"的循环会连发烧完整轮预算。已实现轮次间最小间隔：首轮立即执行，其后各轮等到 `上次排队时刻 + intervalMs`；等待用受 fiber 管理的定时器，暂停/取消/编辑/卸载都会取消它，且过期的唤醒会重新读取循环状态而不会补排（`src/loop.ts` 新增 `MAX_TIMER_DELAY_MS`，同时作为检查点 `intervalMs` 的上界，防止手改检查点造出无法调度的节奏）。
2. **`intervalMs` 在检查点里没有任何测试**：`parseCheckpoint` 的注释明确写着"静默丢弃会把有节奏的循环变成连烧预算的循环"，但该行为无覆盖。已补：往返持久化、无节奏保持无节奏、6 种非法形状（错类型/0/负数/小数/非有限/超定时器上限）被拒、上限本身被接受。
3. **`start` 丢弃用户刚输入的目标**（`src/controller.ts`，经用户授权后修）：对已 pause 的活跃循环执行 `/loop <新目标>` 会静默保留旧目标，用户看到"目标被保留"才知道自己打的字被丢掉了。已改为整条替换（新 id、预算归零）并明确告知。
4. **（自查更正，原非既有缺陷）**：armed 冲突提示原文为 `inspect it with loop_status, stop it with loop_cancel, or let it finish` —— 这三处引用**都真实存在，原文没有缺陷**。本轮为配合新语义补上 `/loop edit` 指引，我在改写时一度写进并不存在的 `loop_edit` 工具，已更正为 `/loop edit`。记录在此以免被误读成"修了一个不存在的 bug"。

### 已排查但证伪（未改动）

- **`commands.register()` 丢弃 disposer 是否会泄漏注册**：`CommandRuntime.register` 内部是 `this.layers.effect(this.ctx, …)`，从实现看像是绑在服务自身的 ctx 上（那样插件卸载就不会撤销注册）。用真实 `@deepseek-ai/dsh-commands` 做对照实验后**证伪**：丢弃 disposer 与显式 `ctx.effect(() => dispose())` 两种写法，在插件 fiber 卸载后注册**都已消失**。故未改动 `installLoopCommand`。教训：不该凭"读了一遍实现"就断定缺陷。
- **`loop_start` 与 `/loop` 是否重复注册**：两者共用同一个 `LoopController` 与 `executeLoopCommand`，不存在两套状态机；真实 Loader 用例与真实 `CommandRuntime` 用例各自断言了注册与卸载的干净性。

### 本轮新增测试

| 文件 | 用例数 | 本轮新增覆盖 |
| --- | --- | --- |
| `test/driver.test.mjs` | 18（+4） | 有节奏时首轮立即、其后被扣住直到间隔到点；无节奏仍立即续跑；卸载取消待唤醒；等待期间暂停后过期唤醒不会补排 |
| `test/checkpoint.test.mjs` | 18（+9） | `intervalMs` 往返、无节奏保持、6 种非法形状被拒、定时器上限被接受 |
| `test/tui.test.mjs` | 6 | `tui.commands` 注册/反注册、无会话提示、错误回显、契约形状校验、`ctx.inject` 门控在服务缺失时不动作 |
| `test/command.test.mjs` | 18（+2） | `/loop` 语法、节奏渲染往返、完整生命周期、paused 循环被整条替换且 `edit` 保留预算、**真实 `CommandRuntime` 契约与卸载释放** |
| `test/loop-detect.test.mjs` | 10 | 规范化、连续链推进、判定、提示渲染 |
| `test/settings.test.mjs` | 24 | 路由校验、真实注册与热更新、嵌套写入不碰兄弟字段、revision 围栏 409 |

## 第三轮（`/loop` 命令、重试配置面板、循环检测）

### 已通过

- `npm run typecheck`：Host 与 Client 双 `tsc --noEmit` 通过。
- `npm test`（完整构建 + `node --test test/*.test.mjs`）：**99 个用例，98 通过，0 失败，1 跳过**（跳过的仍是需 `DSH_COMPOSITION_RUNTIME_MANIFEST` 的真实 Loader 用例）。
- 基线对比：本轮开始时为 47 通过 / 1 跳过（审计轮修复后 50 / 1）；本轮新增 48 个用例。
- 单一插件约束仍然成立：`cordis.patch.yml` 仍只有一条 `insert`，`id: do` / `name: dsh-do`，由 `test/package.test.mjs` 断言。
- 构建产物已同步：`lib/`、`lib/types/`、`lib/client.js` 均由本轮源码重新生成。

### 本轮新增测试

| 文件 | 用例数 | 覆盖 |
| --- | --- | --- |
| `test/command.test.mjs` | 14 | `/loop` 语法（前导/尾部间隔、动词优先级、`every` 消歧）、节奏渲染往返、完整生命周期、已 armed 拒绝、disarmed 重新 arm **保留原目标**、终态替换、缺失状态 |
| `test/loop-detect.test.mjs` | 10 | 深度键排序规范化、连续链推进/重置、判定（阈值/驱动接管/预算耗尽/开关）、提示词渲染与截断 |
| `test/settings.test.mjs` | 24 | 路由请求校验（19 种非法形状）、`readSettingsView` 命名空间收窄、重试草稿读写/校验/构建、路径级 save/reset、目标发现与选择、`isOverridden` 语义、循环草稿往返、**真实 `installDoSettings` 注册 + 热更新**、**真实路由端到端读写 + 嵌套写入不碰兄弟字段 + revision 围栏 409 + 未注册命名空间 + 守卫顺序** |

### 本轮发现并修复的真实缺陷

1. **空 path 被拒**（`src/settings-route.ts`）：面板保存循环配置发送的是命名空间根写入（`path: []`，`applyPathOp` 明确支持），而路由把空 path 判为非法 —— 保存必然失败。已改为允许空 path（仍校验每段是非空字符串）。
2. **恢复提示谎报压缩**（`src/loop-detect.ts`）：`compact: false` 时正文仍告诉模型"历史刚被压缩"。已让续跑句跟随同一开关。
3. 上一轮已修（本轮回归仍覆盖）：`aiInstall` 缺 `signal`、检查点可选字符串静默丢弃、`armed` 与终态自相矛盾。

### 设计决策（需用户确认后才可推翻）

- **`disarmed → 重新 arm` 已被用户明确推翻（本轮改动）**：原设计对已 disarm 的活跃循环再次 `/loop <objective>` 或 `loop_start` 时**保留已存目标**，只是重新 arm。用户答复"都可以"授权推翻。现语义：paused 循环被**整条替换**——新目标、新预算、新节奏，并明确告知"原目标与已用轮次已被替换"。实现上刻意**铸造新 loop id**：已 admit 轮次是从带该 id 的会话事件里数出来的，所以换 id 才真正重置预算；同时它让仍带旧 id 的在途轮次预约失效，旧循环排队的轮次不可能被 admit 进新循环。armed 的循环仍报错，不会被覆盖。`/loop edit <objective>` 保留为"保留已用轮次的中途修正"路径。
- **检测器不中断有驱动接管的会话**：读源码确认官方 `dsh-goal-round-driver`（第 222 行）与本插件 `driver.ts` 都会在**已 admit 的轮次被取消时暂停其机制**。因此检测器在有 armed 循环/目标时只投递纠正提示，不 `cancel`，避免悄悄停掉用户正在跑的循环。

## 第二轮（审计轮）

### 已通过

- `pnpm typecheck`：Host 与 Client 通过。
- `pnpm build`：Host 与 Client bundle 通过；tsdown external/noExternal 存在弃用警告，不影响构建。
- 设置 `DSH_COMPOSITION_RUNTIME_MANIFEST` 指向本机 DSH package.json 后，`node --test test/*.test.mjs`：48/48 通过，0 跳过。
- `git diff --check`：通过。
- 临时 DSH_HOME 安装 tarball：成功；`--dump-config` 为唯一 `id: do / name: dsh-do`。
- 最终临时安装 Host SHA256 与源码 bundle 一致：`BBD0B03734760BBF750905CBC10A52B324FA24762A2088A70C6B9C6F5F0BB7F2`。

### 测试类型

- composition：真实 Cordis、AgentRegistry、SystemPrompt、ToolRuntime，以及安装版 Loader；覆盖依赖等待、四工具注册、重启/卸载、提示与事件清理。Loader 从 patch 提取单行，在内存中改为入口 URL，禁用持久化。不是完整 Web boot。
- driver：实际驱动/controller/Inbox，可控事件；14 项覆盖预算、取消、竞争消息、恢复屏障与卸载。
- ai-install：实际 handler，可控 service 与临时目录；覆盖成功创建、setup 失败回滚、依赖预检、防跨站、方法与 JSON 校验。
- Client：纯状态/请求通道/响应解析测试，不是 DOM 端到端测试。

## 发布及部署边界

正式 Web 安装路径：`C:\Users\Huawei\.dsh\profiles\web\node_modules\dsh-do`。用户明确要求"不用备份旧版"后，已通过 `dsh plugin --profile web add` 安装修复包，并通过 `dsh plugin --profile web install` 恢复一次无关插件依赖树（`ssh2` 缺失）。重启后新错误日志为空，页面返回 200，POST 到 `/dsh-do/ai-install` 使用 `text/plain` 时按预期返回 415。

**注意**：上述部署仍是**审计轮**的产物，不包含本轮（`/loop`、设置面板、循环检测）的代码。本轮改动只完成到源码 + 构建 + 测试，**尚未重新部署到 web profile**，因此浏览器里看不到 dsh-DO 设置页，`/loop` 也还不可用。需要重新打包安装并重启 profile 才能验收。

本轮临时安装目录：`C:\Users\Huawei\AppData\Local\Temp\dsh-do-verify-88ebf6340bc0410abf54435a951aae4e`。
最终测试包：该目录下 `dsh-do-verified-final.tgz`。这是临时验收产物，不应作为长期依赖路径。

同路径同版本 tarball 重装曾显示 Already up to date 却保留旧字节；改用新 tarball 文件名后安装，并用 SHA256 校验才确认更新。之后发布需使用新版本或唯一包路径，不以退出码代替产物身份校验。

临时安装有 peer dependency 提示；真实 Loader 测试复用已安装框架依赖，未证明临时 profile 可独立完整启动。

## 尚未声称完成

- **TUI 内的交互验收**：`--dump-config` 已证明组合成立，但还没有在真实 TTY 里敲过 `/loop`（TUI 需要交互终端，无法在本会话内自动完成）。
- Playwright/真实浏览器的窄屏、焦点、右键交互验收；本轮新增的设置页交互（保存/重置/409 冲突提示）**已确认产物送达浏览器**（见下），但人工点选尚未做。
- 使用实际模型凭证的循环任务、`/loop` 斜杠命令、外部 GitHub 插件安装，以及**模型循环检测的真实触发**（需要真实模型真的陷入重复调用）。
- GitHub 推送或发布。

## 本轮部署（已完成）

第四轮代码已部署到 web profile 并重启验证：

- 打包到新目录 `C:\Users\Huawei\.dsh\local-packages\dsh-do\deploy-cf9d1ed3c6872fc53d84f3e03113737a\dsh-do-0.1.0.tgz`（**新 spec 路径**，避免 pnpm 按"版本号+spec"命中缓存而静默不更新），由 `dsh plugin --profile web add` 写入依赖并保留 `dsh.profile.bundles`（前后均为 16 项，未增未减）。
- 安装副本与打包内产物**逐字节一致**（`lib/index.js` = `C9B45224…`、`lib/client.js` = `2B40EF7A…`）。Host 半至今仍与仓库当前构建同哈希（`C9B45224…`）；Client 半因下述构建非确定性而每次重建都会变，已验证为**功能等价的同源构建**。
- `dsh --profile web --dump-config` 仍输出唯一的 `id: do / name: dsh-do` 行，config 正确。
- 重启后由**新进程**持有 3080 端口（`Get-NetTCPConnection` 确认 OwningProcess 为新 pid），`GET /` 返回 200。
- **端到端确认**：`GET /plugins/dsh-do/client.js` 返回 200 / 57923 字节，且包含 `断连重试策略`、`模型循环检测`、`DoSettingsPage`、`/dsh-do/settings`、`settings.section` 全部新标记 —— 即新客户端产物确实送达浏览器。
- 另一个同名 `node` 进程（路径含 `profiles\web`）经查是 Blender 插件的 `runtime\server.mjs --port 9877`，不是竞争的 DSH 实例。
- web profile 配置备份在 `%TEMP%\dsh-do-web-backup\`（`package.json` 与 `cordis.patch.yml`）。

## 发现（构建工具链，非产品缺陷）：客户端构建非确定性

同源连续三次 `npm run build:client` 产出**三个不同的** `lib/client.js` 哈希（`35097957…` / `4F7FBF19…` / `998A1DCD…`）。

- 逐字节比对定位到差异：打包器为 CSS modules 生成的类名映射**key 顺序不稳定**（一次是 `heading,cancel,card,…`，另一次是 `card,input,actions,heading,…`）。
- 判定为纯重排序：两次构建**字节多重集完全相同**、长度相同（59855）、行数相同（1454），差异行只是"对象最后一项无尾逗号"的语法产物 —— 同一查找表的排列，运行期行为一致。
- 影响：①仓库提交 `lib/` 产物，因此**每次构建都会弄脏工作区**，无法用哈希证明"lib 已同步"（本项目的同步性只能用"构建时间晚于源码时间 + 测试通过"来主张）；②客户端资源的 `?rev=` 缓存戳每次构建都变。
- **未修**：消除它需要在打包器层面固定 CSS module 的发射顺序，超出用户要求的范围，故仅记录不擅改。产物功能不受影响。

## 待用户确认才能动的设计取舍

（无。`disarmed → 重新 arm 保留原目标` 已获用户明确授权推翻，见第四轮"设计决策"。）

第四轮部署包保存在 `C:\Users\Huawei\.dsh\local-packages\dsh-do\deploy-cf9d1ed3c6872fc53d84f3e03113737a\dsh-do-0.1.0.tgz`（上一轮的 `deploy-f71cbce0…` 保留未删）。web profile 以固定本地包依赖，不是 GitHub 依赖。按用户要求未备份旧版；未直接覆盖 node_modules，未启动替代服务器。

TUI profile 的安装前备份保存在 `%TEMP%\dsh-do-tui-backup\`（`package.json` 与 `cordis.patch.yml`），用于必要时还原该 profile。

第二轮 Host SHA256：`BBD0B03734760BBF750905CBC10A52B324FA24762A2088A70C6B9C6F5F0BB7F2`。
第二轮 Client SHA256：`8CC88802094D43A6EAA60E00ABA639A2ABF0E6EB57F60F200C3C5E7AB1A724E4`。
