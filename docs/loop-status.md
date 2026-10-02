# 循环状态可见性（A 方案：只动本插件）

用户 2026-10-01 反馈两件事：**①循环跑起来会"好半天没反应，好像根本没发出请求"**；**②希望循环有一个像 goal 那样的"标"，并且能适配 TUI**；**③模型循环截停也要有显示**。

查证结论（会话日志实锤）：不是没发请求——`loop-0f438edd` 的第 1、2 轮都跑完了完整回合，**第 3 轮的 turn 被 `aborted`**，按官方契约（与 `dsh-goal-round-driver` 逐行一致）暂停循环，**而暂停没有任何提示**，于是看起来像"没反应"。根因是"**静默停止**"，不是请求没发出去。

## 交付的内容

### 1. 暂停原因落库（`src/loop.ts` / `src/checkpoint.ts` / `src/controller.ts`）

`LoopState` 新增 `pausedReason?: { code, message, at }`，`LoopPauseReasonCode` 六种：

| code | 触发点 |
| --- | --- |
| `round-cancelled` | 已 claim/admit 的轮次被取消（真人接管 / 父级取消）→ idle 时暂停 |
| `round-aborted` | turn 被 aborted 且轮次尚未 claim |
| `max-tokens` | 回合撞max-tokens（与官方 goal 驱动同处理） |
| `agent-error` | `agent/error` |
| `driver-failed` | 驱动任务抛错 / 预约校验失败 |
| `restart` | 进程卸载（重启）时仍在 armed |

`armLoop(loop, false, reason)` 记录原因，**`armLoop(loop, true)` 清除原因**（恢复后不该再显示旧的暂停）。检查点解析器把 `pausedReason` 当**结构性字段**校验：非法 code / 非字符串 message / 非有限 at 一律判为损坏记录；且**矛盾组合（armed=true 却带暂停、非 active 却带暂停）也拒绝**，避免状态面报出自相矛盾的结论。

### 2. 暂停时往会话里发通知（`src/prompt.ts` / `src/driver.ts`）

`disarm()` 现在做两件事：记录原因 **+** 用既有的 notice 机制（`form: 'notice'`，与循环检测同一套）往会话里写一条 `<loop_paused>` 消息，说明**原因 + 这是暂停不是结束 + 如何恢复**（`/loop resume`）。

**顺带修掉一个真实缺陷**：`agent/status → idle` 里那条"已取消轮次 → 暂停"的路径原本**直接调 `controller.arm()`，绕过了通知**——而这正是用户实际撞上的那条路径（他们的第 3 轮就是被取消的）。现已改为统一走 `disarm()`，记录与通知都不会漏。

### 3. 状态面：`loops` 服务 + `loop` 投影（新增 `src/loop-status.ts`）

照 goal 的写法复刻：

```js
ctx.provide('loops'); ctx.set('loops', { get(agent), list() })      // 供 TUI 用 ctx.reflect.get('loops')
ctx.inject(['sessionProjections'], (c) => c.sessionProjections.register({
    key: 'loop', schema, init: () => null, apply: applyLoopProjection,
    view: (s) => s, stateVersion: 1,
}))
```

**关键约束（读真实注册表源码后确认）**：投影 cell 是**对会话日志的纯 fold**，注册表会从 seq 0 重放重建。因此 `apply` **不能读活的 controller**（否则取值取决于重放时机）——它只 fold 已 admit 的 loop 轮次（循环被替换时以新 loopId 重新开始计数）。**armed 与暂停原因不在日志里**，所以由 `loops` 服务提供。

`loopStatusView()` 产出**扁平、纯 JSON** 的视图（只取叶子字段，绝不外泄 live 对象）；`renderLoopStatusLine()` 提供统一文案，客户端面板、TUI 状态行、模型的 `loop_status` 三处措辞一致。

### 4. `loop_status` 也暴露暂停原因（`src/tools.ts`）

模型侧原本只能看到 `armed:false`，无从判断该等、该重试、还是该问。现输出 schema 增加 `pausedReason`（含 code 枚举）。

### 5. TUI 接入点（A 方案，留给 TUI 侧）

TUI 的 `/status` 面板是写死在 goal/todos/plan 三个单元上的，因此**插件侧只负责把数据准备好**，面板那一段（`◆ 循环`）照抄 `projectGoalSection` / `goalStatusLabel` 即可，数据来源二选一：

- `ctx.reflect.get('loops', false)` → `get(agent)` / `list()`，返回 `LoopStatusView`；
- 或 `sessionProjections` 快照的 `loop` 单元（`{ loopId, roundsStarted, lastRoundAt }`）。

## 复测结果

- **153 用例 / 153 通过 / 0 失败 / 0 跳过**（本轮 +10）。
- 新增 `test/loop-status.test.mjs`（9 条）+ 检查点暂停往返 1 条 + 驱动暂停通知/原因断言。
- 双端 `tsc --noEmit` 干净，`lib/` 已随完整构建同步。

## 过程中暴露的两个"假 bug"（均为测试脚手架问题，非产品缺陷）

1. `ERR_REQUIRE_ESM_RACE_CONDITION`：并发 `Promise.all(import())` 加载运行时模块所致，顺序加载即解（已记入记忆）。
2. 驱动测试的 `queued` 列表把**驱动通知**和**真人回合**混在一起统计，导致"轮次数量"断言被通知/人话污染。已把 harness 拆成 `queued`（loop 轮次）/ `notices`（plugin 通知）/ `human$1`（真人消息）三路，断言才真正指向各自的对象。

## TUI 侧渲染（用户最终选"一起整"，因此改由本仓库出补丁脚本）

TUI 的 `/status` 面板写死在 goal/todos/plan 三个单元上，注册新 key 不会自动多渲染一段。补丁脚本 `scripts/patch-tui-status-panel.mjs` 对**已安装的 TUI 包**做四处最小改动（幂等，支持 `--check` 只校验）：

1. 新增 `projectLoopSection()`（`◆ 循环` 段：状态 + 目标 + 轮次，**暂停时显示原因**）；
2. `projectStatusPanel(goal, todos, plan, opts, loop = null)` 增加第五参并折叠该段；
3. `renderStatusPanel` 传入 `snapshot.loop`；
4. 渲染快照增加 `loop: this.projectionCache?.loop ?? null`。

**为什么数据能自动到位**：TUI 的 `projectionCache = { ...snap.values }` 会复制**注册表里每一个 key**，`onChanged` 也按 `key` 泛化写入，所以 dsh-do 注册的 `loop` 投影无需 TUI 显式声明就会流进缓存。仅缺"渲染那一段"，这正是补丁补的部分。

补丁落在 `node_modules` 内，**TUI 包升级会丢失**，届时重跑脚本即可。

## 真实注册表端到端验证（`test/loop-status-real.test.mjs`，2 条）

挂载**出厂** `@deepseek-ai/dsh-session-projection` 注册表 + 本插件，断言：`loops` 服务存在；`loop` 投影注册且会话未跑轮次时投影为 `null`；**通过注册表自身的事件通路**投递轮次后 fold 出 `roundsStarted`；**重放稳定**（同一批事件在另一个会话重建得到相同的值 → 证明 fold 不携带活状态）；**卸载后 key 消失**（不会留下失效的面板段）。

> 过程中修正了一个**我自己的探针错误**：注册表的 cell 是按会话缓存的，只经 `drive()`（即 `session/event` 监听）推进。我第一版直接往 `session.events` 里 push 而没发事件，cell 保持陈旧、断言读到 `null`——**这是探针漏发事件，不是产品缺陷**。

## 部署与重启（已完成）

- 构建哈希 `CD18BDE5193C28AB`，`deploy-0dd6f7f6176339f6c6e7c9506c199e0f`。
- **web 与 tui 两个 profile 都已安装**，安装副本哈希与仓库构建**逐字节一致**；`--dump-config` 各自仍唯一 `id: do`，bundles 未变（web 16 / tui 3）。
- 两个 profile 的 base 都挂载了 `session-projection`，所以 `loop` 投影在两边都会注册。
- 已重启（新进程 24968），启动日志无插件报错。
- 构建后复核：仓库 `lib/index.js` 与两个 profile 的安装副本**仍在同哈希**，无需重新部署。

## 尚未完成

- **TUI 内的真实 TTY 目视验收**（敲 `/status` 看 `◆ 循环` 段）——需人工，不伪称已验证。
- 原循环目标剩余项 (b)「循环检测对真实 compaction 的行为」。

---

# 输出上限自动继续 / 模型自动切换 / 配置文件改设置（2026-10-01）

## 现状确认（改动前读源码）

| 问题 | 结论 | 证据 |
| --- | --- | --- |
| `max-tokens` 在哪里处理 | 只有驱动 `turn/end` 分支，直接暂停循环 | `src/driver.ts` |
| 能否换模型 | 能：`agent/request` 是可改写 `provider/model` 的瀑布 | `dsh-agent` `installModelSelection` |
| 失败后谁接手 | `agent/request-error` 瀑布；返回 `{kind:'retry'}` 会重建请求，再走一次 `agent/request` | `dsh-agent-loop` `step()` |
| 现有重试 | `dsh-llm-retry` 挂在同一瀑布，用尽后调 `next()` | `dsh-llm-retry` `recover()` |
| 配置文件 | 已支持：`dsh-settings-file` 用 chokidar 监视 `$DSH_HOME/settings.yaml`，web 与 tui 都挂载；坏值保留旧值并告警 | `dsh-settings` `publish()` |
| TUI 设置栏 | `/config` 只读展示，不能编辑 | TUI `projectConfigPanel` |

## 方案

- 配置文件沿用 `settings.yaml` 的 `dsh-do:` 段，只写想改的键。
- TUI 编辑：新增 `/do-config`，经官方扩展点 `tui.commands` 注册（与 `/loop` 同一方式），同时注册到 web 的 `commands`。本轮没有新增 node_modules 补丁。
- fallback 先 `next()` 让提供方重试跑完，放弃后才切；全部候选失败时原错误照常抛出。

## 复测

- 182 / 182 通过，0 失败，0 跳过（+27）。
- 新增 `test/auto-continue-fallback.test.mjs`（12）、`test/model-fallback-real.test.mjs`（5，真实 Cordis 瀑布）、`test/config-file-real.test.mjs`（3，真实 `settings-file` 监视临时 yaml）、驱动自动继续用例 7 条。
- 部署构建 `7082BFB3ECF67CF2`，web / tui 安装副本一致，各唯一 `id: do`，已重启（进程 7820）。

## 待人工验收

- TUI 真实 TTY 里 `/do-config` 的输出与修改。
- 真实 429 下的切换（需要确实会限流的提供方）。
- Web 设置页两张新卡片的显示与保存。
