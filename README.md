# dsh-DO

**Detail Optimization** —— DeepSeek Harness（DSH）的细节优化插件：Claude Code 同款自主循环（含 `/loop` 斜杠命令）+ 断连重试参数可视化配置 + 模型循环自动截停/压缩/重发 + 侧边栏 GitHub 插件发现/一键 AI 安装 + 右键添加工作区。

> 项目名 **dsh-DO**（Detail Optimization）；npm 包名因 npm 规范必须小写，为 **`dsh-do`**。源码：<https://github.com/toujianjian/dsh-do>

## 功能总览

这是**一个插件、一个安装包、一个配置注册行**，内部包含 Host 与 Client 两端（不是多个插件）：

- **Host 半（loop）**：Claude Code 同款自主循环。模型调用 `loop_start` 启动后，驱动在同一会话里**一轮接一轮自动续跑**，直到 `loop_done`（完成）、轮次预算耗尽（自动 `block`）、`loop_cancel`（取消）或用户中断。人类也可以用 `/loop` 斜杠命令直接驱动同一套循环。
- **Client 半（浏览器 UI）**：侧边栏 GitHub 按钮（Octocat 图标）→ 双标签插件发现（项目搜索 / 插件搜索 + AI 安装）；右键原生"添加工作区"按钮 → 粘贴路径注册工作区；设置区新增 **dsh-DO 设置面板**。
- **设置面板**：可视化编辑循环预算/检查点策略、模型循环检测策略，以及**当前提供方的断连重试参数**（重试次数、退避时长、抖动、重试模式）。

## 具体优化细节

### ① 自主循环（Claude Code 同款 loop）

- 四个模型工具：`loop_start` / `loop_status` / `loop_done` / `loop_cancel`。
- **轮次预算**：`max_rounds`（默认 20），到顶自动 `block(round-limit)`，防失控空转。
- **原子检查点**：每个 loop 一份 JSON 检查点（临时文件 + fsync + rename 原子发布），插件启动自动恢复，会话 resume 后 armed 循环自动续跑——重启/崩溃无需手动干预。
- **竞态围栏**（复用官方 `dsh-goal-round-driver` 模式）：`agent/status` idle 驱动下一轮；`agent/inbox/inserted` 检测竞争提示自动暂停；`agent/pre-step` waterfall 校验轮次预约（round 编号/内容/loop 身份），拒绝陈旧或外来轮次并归还其它已认领消息；`turn/end` aborted/max-tokens、`agent/error`、卸载时全部正确清理。
- **权限模型**：`loop_start` 仅直接人类轮（顶层 agent + 本轮含 `source.kind === 'user'` 消息），拒绝子代理；`loop_done`/`loop_cancel` 仅人类轮或当前循环轮。
- **重放安全**：轮次计数以会话日志中已 admit 的 loop 轮次（`user/message` + `source.kind === 'loop'`）为准，检查点只作提示，重放同一事件序列得到同一状态。
- 与内置 goal 系统并存：goal 是官方事件溯源续跑；dsh-do 是自包含、无事件溯源依赖的独立循环，建议一个任务只用一种机制。

### ①b `/loop` 斜杠命令（人类直接驱动）

把 Claude Code 的 `/loop [interval] <prompt>` 语法与 DSH `/goal` 的控制动词合到一条命令上，人类不必再让模型代劳：

- **间隔语法**：前导 `30s`/`5m`/`2h`/`1d`，或尾部 `every 20 minutes` / `every 2h`。前导 token 优先于尾部子句（与 Claude Code 一致）；`every` 后面不是时间表达式时按普通正文处理，所以 `/loop check every PR` 仍是合法目标。无间隔时默认 10 分钟；低于 1 分钟按 Claude Code 的粒度上取整到 1 分钟。
- **间隔语义**：间隔是**轮次之间的最小间隔**（`intervalMs` 随检查点持久化），首轮立即执行——与 Claude Code"先立刻执行一次，再按 cron 重复"一致。不写间隔则空闲即续跑。
- **控制动词**：`/loop`（查看状态）、`pause`、`resume`、`edit <objective>`（替换目标、保留预算）、`done [summary]`、`cancel [reason]`（`clear` 为别名）。
- **start 与 edit 的分工**：对已 pause 的活跃循环再次 `/loop <objective>` 会**整条替换**（新目标、新预算、新节奏）并明确告知——`/loop <objective>` 的语义就是"跑这个目标"，不该悄悄留下旧目标。`/loop edit <objective>` 则**保留已用轮次**，用于中途修正目标。armed 的循环永不被覆盖（先 `edit`/`pause`/`clear`）。

### ①c 模型循环自动截停 / 压缩 / 重发

- **检测**：挂 `tools/post-execute`，对每个 agent 统计**连续相同工具调用**；参数先做深度键排序再比较，所以属性顺序不同不算差异，数组顺序不同则算。真实人类消息（`agent/pre-step` 中 `source.kind === 'user'`）会重置链条与干预预算。
- **恢复**：达到阈值后 `agent.cancel({kind:'hook'})` 中断该轮 → `await whenIdle()` → `ctx.compaction.compactNow()` 压缩历史 → `agent.followup()` 重发请求，提示词告知模型"刚才那个重复调用不是有效下一步"。
- **不误伤其它驱动**：DSH 的 goal 轮次驱动与 dsh-do 自己的 loop 驱动都会在**已 admit 的轮次被取消时暂停其机制**（官方行为，已读源码确认）。因此在有驱动接管续跑的会话里，检测器**只投递纠正提示、不中断**，避免悄悄停掉你正在跑的循环或目标。
- **自我限流**：`maxInterventions` 限制单轮干预次数，到顶后降级为提示，防止恢复流程自己变成循环。

### ①e 输出上限自动继续

- 回合以 `max-tokens` 结束（回答被输出 token 上限截断）时，不再暂停循环，而是追加一轮 `<output_limit_continue>`，要求模型**从断点接着写、不要重来**。
- 续写轮是排在收件箱里的下一轮输入，驱动不会在它上面再叠一轮 loop round，**不消耗轮次预算**。
- 连续截断超过 `maxContinuations` 次就停下，按原有方式暂停循环并写 `<loop_paused>` 提示（原因写明"连续 N 次撞上限"），防止失控的超长回答无限续写。正常结束的回合或一条真人消息会把计数清零。
- 关掉开关即回到官方 goal 驱动的语义：撞上限就暂停。

### ①f 模型自动切换（fallback）

- 挂在 `agent/request-error` 瀑布上，并且**先调用下游**：提供方自己的重试策略（`dsh-llm-retry`）照常对同一模型退避重试；只有它放弃之后才切换。
- 切换由 `agent/request` 瀑布落地，以 `prepend` 注册为最外层，所以会话自己的模型选择先解析，再被替换 `provider/model`；旧模型的 `reasoningEffort` 会被去掉，避免新模型不支持。
- 候选按顺序尝试，跳过已失败的和当前失败的那个；**全部失败时原错误照常抛出**，与未开启时一致。
- 切换对本会话保持，直到下一条**真人消息**，届时先回到你选的模型；loop 轮次、插件提示、自动续写不会重置。
- 默认关闭。错误码默认 `RATE_LIMIT`（429）、`QUOTA`、`SERVER`、`TIMEOUT`、`TRANSPORT`、`EMPTY_RESPONSE`；鉴权失败（`INVALID_CREDENTIAL`）、上下文超长（`CONTEXT_WINDOW_EXCEEDED`）默认不切，因为换模型通常解决不了。

### ①d 断连重试参数可配置

- DSH 内置的重试策略（`dsh-llm-retry` 本身无配置）实际位于**各 provider 适配器配置**里，由路由注册时捕获：
  - pi-ai：`llm-pi-ai` 命名空间的 `providers.<id>.retryPolicy`
  - 官方 DeepSeek：`llm-deepseek` 命名空间的 `retryPolicy`
- 面板按命名空间**发现实际暴露的策略**（未组合的适配器不出现），并默认打开**当前活跃提供方**（读 `agent-default-model`）。可改 `mode`（normal/always）、`maxRetries`、`initialDelayMs`、`maxDelayMs`、`jitterRatio`。
- 写入走**路径级 op**（`{op:'set', path:['providers','huoshan','retryPolicy']}`），因此**不会把整个 providers 映射物化成用户覆写**，同提供方的其它字段（如 apiKey）原样保留。重置即 `unset` 该路径，回到组合默认。
- `mode` 是 schema 必填项，所以一次保存总是写入完整策略对象；`retryableCodes` 有意不写，保留适配器内置错误码列表。
- 写入仍以 Host 为唯一权威：`ctx.settings.mutate(ns, ops, expectedRevision)` 保留 revision 围栏与 schema 校验，冲突返回 409 且保留草稿。

### ② 侧边栏插件发现（GitHub）

- 入口挂在官方 `sidebar.footer.action` slot：**GitHub Octocat 图标**（内联 SVG），窄侧边栏只显图标、宽侧边栏图标 + 文字。
- **双标签**：
  - **「项目」**：通用 GitHub 项目搜索——输入任何关键词自由搜索（不加任何前缀），结果只浏览（仓库名/星数/描述），**不含安装**。
  - **「插件」**：GitHub 插件搜索——留空浏览 `dsh-plugin` 相关仓库，结果带 **AI 安装**按钮。
- **自由关键词**：任何输入都按原词搜索 GitHub（`topic:`/`dsh-plugin` 前缀只在留空浏览时作为默认查询），因此能搜到 Deepseek-Harness-EAC 这类**没打标签**的仓库。

### ③ AI 一键安装

- 插件结果每条带 **AI 安装**按钮：点击 → host 端 `POST /dsh-do/ai-install` → 创建**全新会话**并注入安装提示词 → 新会话出现在侧边栏列表，agent 自动开始安装。
- 安装提示词内置**校验步骤**：先确认 `dsh.bundle` 与产物完整可加载，再 `dsh plugin --profile web add github:<owner>/<repo>`，最后验证 `--dump-config` 并提示是否需要重启。
- **专属工作区**：每次 AI 安装都会在 DSH 安装目录下新建一个专属文件夹（`$DSH_HOME/dsh-do-installs/install-<uuid>`，`DSH_HOME` 未设置时用 `~/.dsh`），注册为正式 DSH 工作区，并把该目录作为新会话的 `cwd` —— 安装 agent 只在自己独立的工作区里干活，不会跑进用户其它工作区。
- 新会话自动继承部署环境事实：模型路由（默认模型选择 → 兜底 live agent）+ 上面创建的专属工作区目录，persona 的 `{{model}}`/`{{cwd}}` 不缺值。
- 新会话会**加入部署的 agent preset**（在 `agents.create` 的 `setup` 里 `agentPresets.mount`，并把 preset id 记进 session meta），因此和普通会话一样拥有完整工具能力（bash/fs/web/…），不是一个空工具列表的裸会话。

### ④ 右键添加工作区

- 复用侧边栏**原生**"添加工作区"按钮（按 `aria-label` 中英匹配）：右键它 → 弹出输入框 → 粘贴目录路径（Windows `C:\...` / POSIX `/...` 均可）→ 回车注册为 DSH 正式工作区（走 `ctx.workspaces.create`），侧边栏立即出现。
- 失败有明确错误提示；点击遮罩/Esc 关闭。

### ⑤ 移动端适配

- 搜索面板在 ≤480px 下变为**全宽底部抽屉**（左右 8px 边距），避开 iPhone 手势条（`env(safe-area-inset-bottom)`）。
- 添加工作区对话框同样在手机上切换为全宽底部弹出（每次打开重新检测视口）。
- 触控目标加大（搜索/AI 安装/关闭按钮），面板高度限制视口内滚动。

### ⑥ 配色与视觉

- 全部文字/边框/背景使用**固定深色值**（不依赖 DSH 主题 token——部分部署的 token 渲染过浅导致文字看不清），浅色主题下清晰可读。
- 悬浮球时代遗留的渐变/光晕已移除，统一中性黑白灰。

### ⑦ 工程细节

- Client bundle 走官方 tsdown 链路：`window.__ModuleLoader__.load` 包装、CSS Modules 内联注入、跨包纯度门、sourcemap。
- Host 路由（AI 安装）用 `ctx.inject` 惰性挂载（不抢跑兄弟 provider），请求体有大小上限、统一 JSON 错误与 `no-store` 缓存策略。
- 纯函数可测试：loop 状态机、`/loop` 命令语法与渲染、模型循环检测与判定、检查点往返/原子性、设置写入请求校验与重试策略读写，加上驱动竞态、节奏等待、安装 HTTP、Client 状态与真实 Cordis 注册/卸载（`node --test` 覆盖 188 个用例；设置 `DSH_COMPOSITION_RUNTIME_MANIFEST` 后含真实 Loader 用例也一并实跑，否则该项跳过）。

## 工作原理

```
用户 → 模型: "帮我完成 X"
模型 → loop_start { objective: X, max_rounds: N }   ← 本轮内调用，要求直接人类输入
      │  驱动记录 loop: { phase: active, armed: true }，原子写检查点
      ▼
当前轮结束 → agent/status idle → 驱动队列 round 1 (<loop_round>)
      ▼
round 1 执行（模型工作、调用工具、验证）
      ▼
轮结束 → 模型调用了 loop_done？→ phase=completed，写检查点，停止
        │ 否则：轮数 >= maxRounds？→ phase=blocked(round-limit)，写检查点，停止
        ▼
        队列 round 2 …（循环）
```

## 安装

只支持从 **GitHub** 安装（构建产物已提交，无需本地构建）：

```sh
npx -p @deepseek-ai/dsh dsh plugin --profile web add github:toujianjian/dsh-do
```

安装成功后**重启目标 profile** 生效。验证：

```sh
npx -p @deepseek-ai/dsh dsh --profile web --dump-config   # 应出现 dsh-do 行
```

## 配置

### 组合层（`cordis.patch.yml` 的 `config`）

整段替换语义，覆盖时需重述全部键；这一层是 `dsh-do` 命名空间的 `base`：

| 键 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `defaultMaxRounds` | number | `20` | `loop_start` 省略 `max_rounds` 时的轮次预算 |
| `checkpointDir` | string | `""` | 检查点目录；空串 = `$DSH_HOME/loops`（`DSH_HOME` 未设置时为 `~/.dsh/loops`） |
| `persist` | boolean | `true` | 置 `false` 仅内存保存（不落盘） |
| `loopDetection.enabled` | boolean | `true` | 是否启用模型循环检测 |
| `loopDetection.repeatThreshold` | number | `4` | 连续相同工具调用多少次判定为循环 |
| `loopDetection.compact` | boolean | `true` | 恢复前是否压缩历史 |
| `loopDetection.maxInterventions` | number | `2` | 单轮最大干预次数 |
| `autoContinue.enabled` | boolean | `true` | 输出被 token 上限截断时自动继续 |
| `autoContinue.maxContinuations` | number | `3` | 同一段回答连续自动继续的上限，到顶后暂停循环并提示 |
| `autoContinue.onlyWhileLooping` | boolean | `true` | 只在循环运行中自动继续；`false` 时普通对话也会续写 |
| `modelFallback.enabled` | boolean | `false` | 模型失败时自动切换到候选模型 |
| `modelFallback.candidates` | string[] | `[]` | 候选模型，按顺序，写作 `provider/model` |
| `modelFallback.triggerCodes` | string[] | `RATE_LIMIT, QUOTA, SERVER, TIMEOUT, TRANSPORT, EMPTY_RESPONSE` | 触发切换的错误码 |

### 用户层（`$DSH_HOME/settings.yaml` 的 `dsh-do:` 段）

在设置区 **dsh-DO** 面板里改的值写到这里，**热生效、无需重启**：轮次预算与检测策略由工具/驱动**实时读取**；`persist`/`checkpointDir` 变化会**换用新的检查点 store**（改动只影响之后写入的检查点，不会迁移或复活已有循环）。

**直接改文件**：`settings.yaml` 由 DSH 自带的 `settings-file` 提供方以文件监视方式读取（web 与 tui 两个 profile 都挂载），保存后约 0.1 秒内重新载入，**不用重启**。只写你想改的键，其余沿用默认；写错的值会被 schema 拒绝并在日志里报警，原值保持不变。最简示例：

```yaml
dsh-do:
  autoContinue:
    maxContinuations: 5
  modelFallback:
    enabled: true
    candidates:
      - deepseek/deepseek-chat
      - openai/gpt-4o
```

**命令行改（TUI 推荐）**：`/do-config`，同时注册在 Web 的命令服务和 TUI 的 `tui.commands`，写入同一个 `dsh-do:` 段，立即生效。

| 命令 | 作用 |
| --- | --- |
| `/do-config` | 列出全部设置及当前值 |
| `/do-config <路径>` | 查看一项，如 `/do-config modelFallback.candidates` |
| `/do-config <路径> <值>` | 修改，如 `/do-config modelFallback.enabled on` |
| `/do-config reset <路径>` | 去掉覆写，回到默认 |
| `/do-config file` | 显示设置文件位置 |

值的写法很宽松：布尔接受 `true/false`、`on/off`、`开/关`；列表接受逗号、空格、换行或 JSON 数组；路径可只写唯一的末段（`candidates` 等同 `modelFallback.candidates`）。

同一面板还能编辑**断连重试策略**，它写进的是提供方自己的命名空间（`llm-pi-ai` / `llm-deepseek`），不是 `dsh-do`：

```yaml
llm-pi-ai:
  providers:
    huoshan:
      retryPolicy:
        mode: normal
        maxRetries: 5
        backoff:
          initialDelayMs: 500
          maxDelayMs: 10000
          jitterRatio: 0.1
```

## 工具

| 工具 | 用途 | 权限 |
| --- | --- | --- |
| `loop_start { objective, max_rounds? }` | 启动循环；已有 active 循环时：armed → 报错，paused → 用新目标整条替换（新 id、预算归零） | 仅直接人类轮；拒绝子代理 |
| `loop_status` | 读当前循环（id/objective/phase/armed/轮次/预算/原因） | 当前驱动内的调用 agent |
| `loop_done { summary? }` | 标记完成；循环轮内调用会注入 `<loop_complete>` 收尾提示 | 直接人类轮 **或** 当前循环轮 |
| `loop_cancel { reason? }` | 标记取消；同上注入 `<loop_cancelled>` 收尾提示 | 直接人类轮 **或** 当前循环轮 |

工具均要求：调用 agent 处于活跃驱动、当前 turn 未关闭（复用官方 `dsh-tool-goal` 的权威校验模式）。

## 斜杠命令

| 命令 | 用途 |
| --- | --- |
| `/loop` | 查看当前循环（phase / objective / 轮次 / 节奏 + 可用动词提示） |
| `/loop <objective>` | 启动循环；已 armed 时报错并提示改用 `edit`/`pause`/`clear` |
| `/loop 5m <objective>` | 启动并按 5 分钟节奏续跑（`every 20 minutes` 等价） |
| `/loop pause` / `/loop resume` | 停止 / 恢复自动续跑 |
| `/loop edit <objective>` | 替换目标，保留预算与已用轮次 |
| `/loop done [summary]` | 标记完成 |
| `/loop cancel [reason]`（`clear` 同义） | 取消循环 |

`/loop` 与四个工具驱动**同一套循环状态**，可混用；一个会话同时只有一个 active 循环。

## TUI 兼容

dsh-do 的 Host 半在 `dsh-tui`（`@huiliyi37/dsh-tianshu-tui`）的 profile 下完整可用：该 profile 由 `dsh-base` + TUI 组成，`agents` / `tools` / `systemPrompt` / `commands` / `settings` / `compaction` 都在，因此四个工具、`/loop`、循环检测与设置存储都正常挂载；只有 Web 专属的 `/dsh-do/settings` 路由不安装（TUI 没有 `webServer`，由 `ctx.inject` 门控自动跳过）。

斜杠命令注册两处：DSH 的 `commands` 服务（Web 消费）与 TUI 自己的 `tui.commands` 注册表。TUI 不读前者，它自己 `provide('tui.commands', …)` 并在源码里注明 `ctx.get('tui.commands')?.register(...)` 是扩展点。dsh-do 用 `ctx.inject(['tui.commands'])` 等待该服务出现——Web/headless 下它永不出现，注册即静默跳过，不产生副作用。

安装到 TUI profile：

```sh
dsh plugin --profile tui add <dsh-do 的 tarball 或包名>
dsh --profile tui --dump-config   # 应看到唯一的 `id: do` 行与 `id: tui-runner` 并存
```

### DSH 版本兼容

下列 dsh / dsh-tui 组合都做过**真实 TTY** 验收（`/loop` 敲进去、状态栏 `◆ 循环` 段渲出来），可用 `test-docker/` 复现：

| dsh | dsh-tui |
| --- | --- |
| 0.1.0-rc.8 | 0.1.1-rc.6 |
| 0.1.5-rc.3 | 0.1.2-rc.31 |
| 0.1.7-rc.2 | 0.1.2-rc.31 |
| 0.2.0-rc.2 | 1.0.0-rc.2 |

跨版本差异已在插件内处理：

- **会话日志读取**：DSH 0.1.5-rc.3 移除了 `Session.events` getter，改为 `snapshotEvents()`（整段日志）与 `ownEvents()`（排除 fork 继承前缀）。`src/session-log.ts` 按能力探测并回退，一份构建同时服务新旧两代。
- **peer 范围**：`^0.1.0-rc.6 || ^0.2.0-rc.1`。dsh 0.2.x 有版本闸门，范围不覆盖就会被**拒绝装载**（`skipping profile bundle "dsh-do"`），不是崩溃。
  **升级提醒**：如果你在 peer 范围放宽**之前**装过 dsh-do，把 dsh 升到 0.2.x 后插件会被**静默跳过**——症状是 `/do-config`、`/loop` 一起消失（在 TUI 里敲 `/do-config` 会被当成普通消息发给模型，看起来像命令坏了），而 dsh 自身一切正常。重装一次即可：`dsh plugin --profile <profile 名> add <dsh-do 的 tarball 或包名>`；装完 `dsh --profile <profile 名> --dump-config` 里搜 `skipping profile bundle` 应为 0 条。
- **TUI 状态栏补丁**：同时支持 `projectStatusPanel(...)` 的单行与跨行展开两种调用形状；形状再变时明确失败且不写文件。

**Windows 黑窗**：上游 `dsh-subprocess-local` 从 0.1.5-rc.3 起才在 spawn 处带 `windowsHide`。停留在 0.1.0-rc.8 时子进程会闪黑窗，升级即消失——这一层不在本插件内。

## 开发与验证

```sh
pnpm install
pnpm typecheck      # host + client 双 tsc --noEmit
pnpm build          # build:host（tsc）+ build:client（tsc + tsdown → lib/client.js）
pnpm test           # 完整构建 + node:test（状态/驱动/HTTP/Client/真实 Cordis/包契约）
pnpm watch          # tsdown --watch（client HMR 构建）
```

验证分层：类型检查与构建；纯函数/文件/驱动/HTTP 测试；真实 Cordis 注册与卸载；临时 DSH_HOME 的 tarball 安装与 `--dump-config`（注册行 id 为 `do`，包名 `dsh-do`）。配置打印不等于完整运行。

可选真实 Loader 测试：设置 `DSH_COMPOSITION_RUNTIME_MANIFEST` 为本机已安装 DSH 的 `package.json` 绝对路径，再运行 `pnpm test`；未设置时该测试明确跳过。该测试不启动 Web 或调用模型，浏览器与真实安装会话仍须单独验收。

TUI 的 `◆ 循环` 段由 `scripts/patch-tui-status-panel.mjs` 打到已安装的 `dsh-tianshu-tui` 上（幂等，`--check` 只校验，已打旧版可就地升级）。**该补丁落在 `node_modules` 内，TUI 包升级会丢失，届时重跑脚本即可。** 数据来源是 `loops` 服务（`ctx.reflect.get('loops', false)`），不是 `loop` 投影——投影是对会话日志的纯 fold，只含 `{ loopId, roundsStarted, lastRoundAt }`，没有目标/暂停原因；早先按投影取字段会喂 `undefined` 给截断器并在渲染定时器里抛错，**直接掀掉整个 TUI 进程**。`test/tui-patch.test.mjs` 用投影的真实形状钉住了这个崩法。

**端到端 loop 验证**（需要模型凭证）：

```sh
npx -p @deepseek-ai/dsh dsh --profile web "用 loop_start 启动一个循环，目标：打印三行 hello；max_rounds 设 2；完成后调用 loop_done"
```

预期：第一轮完成打印 → 驱动自动队列第 2 轮 → 模型 `loop_done` → 循环 phase=completed，
`$DSH_HOME/loops/loop-*.json` 出现终止记录。

**浏览器 UI 验证**：重启 web profile 后：
1. 侧边栏底部出现 GitHub 图标 → 点开面板 → 「项目」通用搜索 / 「插件」搜索 + AI 安装；
2. 插件条目点「AI 安装」→ 侧边栏出现 `dsh-do-install-*` 新会话自动安装；
3. 右键侧边栏"添加工作区"按钮 → 粘贴路径 → 回车 → 工作区出现在侧边栏；
4. 打开设置 → 左侧出现 **dsh-DO** 页 → 改「默认最大轮次」为 3 → 保存 → 出现「已保存。」；`$DSH_HOME/settings.yaml` 出现 `dsh-do:` 段；
5. 同页「断连重试策略」应默认选中当前提供方（本机为 `huoshan`）→ 改「最大重试次数」为 9 → 保存 → `settings.yaml` 的 `llm-pi-ai.providers.huoshan.retryPolicy.maxRetries` 变为 9，且同提供方的 `apiKey` 等字段未被改动。

**`/loop` 命令验证**（需要模型凭证）：在会话里输入 `/loop 1m 打印一行 hello`，首轮应立即执行；`/loop` 查看状态；`/loop cancel` 结束。

## 项目结构与整合

完整模块关系、修复记录和后续风险见 [架构梳理](docs/architecture.md)（源码仓库文档）。根包不再依赖未接入的本地 `link:dsh-loop-detector`；该历史实验目录仅保留参考，不是需要额外安装的插件。其中的"模型自循环检测"思路已按 DSH 的真实事件契约重写为 `src/loop-detect.ts`（`tools/post-execute` 计数 + `agent/pre-step` 重置），不再使用历史实验的 `@dsh-std/*` 协议。

Host 半源码：`src/index.ts`（入口）、`loop.ts`（纯状态机）、`controller.ts`（注册表 + 检查点提交）、`checkpoint.ts`（原子文件存储）、`driver.ts`（轮次驱动 + 竞态围栏）、`tools.ts`（四个模型工具）、`command.ts`（`/loop` 语法与执行）、`loop-detect.ts`（循环检测与恢复）、`settings.ts`（`dsh-do` 命名空间）、`settings-route.ts`（浏览器读写桥）、`prompt.ts`、`ai-install.ts`。

Client 半源码：`src/client/index.ts`（入口）、`github.ts`（纯解析 + 请求通道）、`GitHubSearchButton.tsx`、`doSettings.ts`（纯逻辑）、`DoSettingsPage.tsx`（设置页）、`addWorkspace.ts`、`AddWorkspaceDialog.tsx`。

修复包括：工具输出 schema 注册失败、自动轮次与用户输入竞态、损坏检查点恢复、Client 旧请求隔离、GitHub 响应校验，以及安装请求防跨站/依赖预检/失败回滚。源码构建不会自动替换已通过 GitHub 安装的副本；升级后再重启目标 profile，不能仅重启旧安装。

## 已知限制

- **GitHub 搜索**走公开 API，未带 token 时有速率限制（约 10 次/分钟）。
- 右键添加工作区通过 `aria-label` 匹配现有按钮（中/英），官方若改文案需同步更新选择器。
- 一个会话同时只允许一个 active 循环（需先 `loop_cancel` 或等其结束）。
- 检查点文件为单进程 last-write-wins（与官方 `dsh-storage-json` 同语义）；多进程写同一 root 不保证。
- `roundsStarted` 以会话日志为准；无持久化后端的会话在重启后不会自动续跑（新会话 id 与已存 loop 不匹配，属预期）。
- 模型必须遵守"达成目标就 `loop_done`"，预算耗尽只是兜底；与 goal 工具一样依赖模型的完成判断。
- **设置面板的写入不经过官方 client settings scope**：重试策略位于嵌套路径（`providers.<id>.retryPolicy`），而 scope 的 `set` 只写顶层字段，且 `bind()` 硬依赖 `connection`/`remote` 两个客户端服务。因此读写都走本插件自己的 `/dsh-do/settings` 路由（与既有 GitHub/AI 安装链路同构），revision 围栏与 schema 校验仍由 Host 的 `ctx.settings.mutate` 承担。代价是面板不会自动跟随其它界面（如 Models 页）对同一命名空间的改动，需点「放弃修改并重新读取」。
- **模型循环检测**只在没有自主驱动接管续跑的会话里中断；有循环/目标驱动时降级为提示，这是为避免取消已 admit 的轮次而暂停官方 goal 或 dsh-do 循环（两者的既有行为）。
- **`/loop` 的间隔**是轮次间最小延迟，不是 cron；DSH 没有重复执行斜杠命令的调度器，节奏由 dsh-do 自己的驱动实现。间隔的起点记在驱动内存里，所以进程重启后的首轮立即执行、其后才按节奏——与"先立刻执行一次"的语义一致。
- **TUI 下的 `/loop` 走 TUI 自己的注册表**：`dsh-tui` 不消费 DSH 的 `commands` 服务，而是自己 `provide('tui.commands', …)`。dsh-do 两者都注册（Host 侧各自 `ctx.inject` 门控），所以在 Web 与 TUI 下 `/loop` 都可用；TUI 未安装时该注册静默跳过。TUI 的命令行参数提示由 TUI 渲染，dsh-do 只提供 `argsHint` 文本。
