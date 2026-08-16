# dsh-DO

Detail Optimization —— Claude Code 同款 loop，DeepSeek Harness（DSH）的自主循环插件。

> 项目名 **dsh-DO**（Detail Optimization）；npm 包名因 npm 规范必须小写，为 **`dsh-do`**。

插件分两半：

- **Host 半（loop）**：Claude Code 同款自主循环。用户提出一个长期目标后，模型调用 `loop_start` 启动循环；驱动（driver）在同一会话里**一轮接一轮自动续跑**（每轮注入 `<loop_round>` 提示），直到：

  - 模型调用 `loop_done` 标记完成（达成目标）；
  - 达到 `maxRounds` 轮次预算（驱动自动 `block`，`round-limit`）；
  - 模型调用 `loop_cancel` 标记阻塞/取消；
  - 用户中断当前轮（循环自动 disarm，`loop_start` 可重新 arm）。

  循环状态（objective、轮次预算、phase、已开始轮数、原因）以**原子 JSON 检查点**落盘，插件启动时自动恢复；会话重新上线（如 resume 持久化会话）后，armed 的循环自动续跑 —— 重启/崩溃后无需手动干预。

- **Client 半（浏览器 UI，demo）**：
  - **悬浮球**（`shell.overlay`）：可拖动、位置记忆（localStorage）；点击弹出面板，内含：
    - harness 插件安装建议（静态）；
    - **GitHub 搜索**：真实调用 GitHub API 搜 `topic:dsh-plugin` 项目；
    - **dshplugin.app 目录**：经 host 代理（`GET /dsh-do/registry`）抓取并解析 DSH Plugin Registry 的插件列表（名称/分类/安装命令/GitHub 链接）。
  - **右键添加工作区**：右键侧边栏现有的"添加工作区"按钮，弹出输入框，粘贴目录路径（Windows/POSIX 均可）即注册为 DSH 正式工作区（走 `ctx.workspaces.create`）。

> 与内置 goal 系统的关系：goal 是 harness 官方的事件溯源续跑机制；`dsh-do` 提供的是**自包含的、无事件溯源依赖的** Claude Code 式循环（独立的检查点文件 + 轮次预算 + 权限模型），两者可并存，建议一个任务只用一种机制。

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

驱动复用官方 `dsh-goal-round-driver` 的竞态围栏模式：

- `agent/status` idle 时驱动下一轮；
- `agent/inbox/inserted` 检测竞争提示（`competingQueued`），暂停自动续跑；
- `agent/pre-step` waterfall 校验轮次预约（round 编号、内容、loop 身份必须一致），拒绝陈旧/外来轮次并归还其它已认领消息；
- `turn/end` aborted / max-tokens 时 disarm；`agent/error`、dispose、插件卸载时全部清理。
- 轮次计数以**会话日志中已 admit 的 loop 轮次**为准（`user/message` 且 `source.kind === 'loop'`），检查点只作提示，重放安全。

## 安装

本插件是标准 DSH bundle 包（host-only，无 client）。任选一种分发形态：

```sh
# GitHub（推荐，已发布：https://github.com/toujianjian/dsh-do）
npx -p @deepseek-ai/dsh dsh plugin --profile web add github:toujianjian/dsh-do

# tarball
pnpm pack                                   # 生成 dsh-do-0.1.0.tgz
npx -p @deepseek-ai/dsh dsh plugin --profile web add ./dsh-do-0.1.0.tgz

# 本地路径（link 安装：目标目录需自带 node_modules，见下）
npx -p @deepseek-ai/dsh dsh plugin --profile web add /path/to/dsh-do
```

安装成功后**重启目标 profile** 生效。验证：

```sh
npx -p @deepseek-ai/dsh dsh --profile web --dump-config   # 应出现 dsh-do 行
```

> 本地路径 `add` 使用 pnpm `link:` 语义：目标包被当作已安装，peer 依赖（`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`dsh-agent`、`dsh-llm`、`dsh-session`、`dsh-tools`、`dsh-system-prompt`）需要在该目录的 `node_modules` 中可解析。tarball/Git 安装由 pnpm 自动链接 peer，无此限制。

## 配置

`cordis.patch.yml` 中的 `config`（整段替换语义，覆盖时需重述全部键）：

| 键 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `defaultMaxRounds` | number | `20` | `loop_start` 省略 `max_rounds` 时的轮次预算 |
| `checkpointDir` | string | `""` | 检查点目录；空串 = `$DSH_HOME/loops`（`DSH_HOME` 未设置时为 `~/.dsh/loops`） |
| `persist` | boolean | `true` | 置 `false` 仅内存保存（不落盘） |

## 工具

| 工具 | 用途 | 权限 |
| --- | --- | --- |
| `loop_start { objective, max_rounds? }` | 启动循环；已有 active 循环时：armed → 报错，disarmed → 重新 arm（沿用已存 objective） | 仅直接人类轮（顶层 agent + 本轮含 `source.kind === 'user'` 消息）；拒绝子代理 |
| `loop_status` | 读当前循环（id/objective/phase/armed/轮次/预算/原因） | 当前驱动内的调用 agent |
| `loop_done { summary? }` | 标记完成；循环轮内调用会注入 `<loop_complete>` 收尾提示（模型写结束语） | 直接人类轮 **或** 当前循环轮 |
| `loop_cancel { reason? }` | 标记取消；同上注入 `<loop_cancelled>` 收尾提示 | 直接人类轮 **或** 当前循环轮 |

工具均要求：调用 agent 处于活跃驱动、当前 turn 未关闭（复用官方 `dsh-tool-goal` 的权威校验模式）。

## 开发与验证

```sh
pnpm install
pnpm typecheck      # host + client 双 tsc --noEmit
pnpm build          # build:host（tsc）+ build:client（tsc + tsdown → lib/client.js）
pnpm test           # build:host + node:test（纯领域/提示/检查点/registry 解析器）
pnpm watch          # tsdown --watch（client HMR 构建）
```

已在本仓库验证：`typecheck`、`build`、`node --test`（20 个用例）、真实组合验证
（`dsh plugin --profile <scratch> add <tarball>` → `--dump-config` 出现 `dsh-do` 行 →
全新 profile 完整 boot 无 fiber/加载错误；client bundle `lib/client.js` 为
`window.__ModuleLoader__.load({...})` 包装，`/dsh-do/registry` 代理路由注册成功）。

**端到端 loop 验证**（需要模型凭证，如 `DEEPSEEK_API_KEY`）：

```sh
npx -p @deepseek-ai/dsh dsh --profile web "用 loop_start 启动一个循环，目标：打印三行 hello；max_rounds 设 2；完成后调用 loop_done"
```

预期：第一轮完成打印 → 驱动自动队列第 2 轮 → 模型 `loop_done` → 循环 phase=completed，
`$DSH_HOME/loops/loop-*.json` 出现终止记录。重启后 `loop_status` 仍能读到该记录。

**浏览器 UI 验证**（悬浮球 / 右键添加工作区）：

```sh
pnpm pack
npx -p @deepseek-ai/dsh dsh plugin --profile web add ./dsh-do-0.1.0.tgz
# 重启 web profile，打开 DSH 网页：
#  1. 右下角出现可拖动的渐变 "DO" 悬浮球 → 点击弹出面板：
#     安装建议 / 搜索 GitHub dsh-plugin 项目 / 抓取 dshplugin.app 目录；
#  2. 侧边栏右键"添加工作区"按钮 → 粘贴目录路径 → 回车 → 侧边栏出现该工作区。
```

## 已知限制

- **dshplugin.app 目录解析**依赖该站首页内嵌的 RSC 数据结构（`$R[N]={slug:...}` 片段）；
  站点改版后解析可能失效，host 代理会返回 502/空列表而非崩溃。
- **GitHub 搜索**走公开 API，未带 token 时有速率限制（搜索接口约 10 次/分钟）。
- 悬浮球为 **demo** 形态：位置存 localStorage，面板内容静态建议 + 真实搜索/抓取。
- 右键添加工作区通过 `aria-label` 匹配现有按钮（中/英），若官方改文案/加 data 属性需同步更新选择器。

- 一个会话同时只允许一个 active 循环（需先 `loop_cancel` 或等其结束）。
- 检查点文件为单进程 last-write-wins（与官方 `dsh-storage-json` 同语义）；多进程写同一 root 不保证。
- `roundsStarted` 以会话日志为准；无持久化后端的会话在重启后不会自动续跑（新会话 id 与已存 loop 不匹配，属预期）。
- 模型必须遵守"达成目标就 `loop_done`"，预算耗尽只是兜底；与 goal 工具一样依赖模型的完成判断。
