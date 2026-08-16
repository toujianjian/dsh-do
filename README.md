# dsh-DO

**Detail Optimization** —— DeepSeek Harness（DSH）的细节优化插件：Claude Code 同款自主循环 + 侧边栏 GitHub 插件发现/一键 AI 安装 + 右键添加工作区。

> 项目名 **dsh-DO**（Detail Optimization）；npm 包名因 npm 规范必须小写，为 **`dsh-do`**。源码：<https://github.com/toujianjian/dsh-do>

## 功能总览

插件分两半：

- **Host 半（loop）**：Claude Code 同款自主循环。模型调用 `loop_start` 启动后，驱动在同一会话里**一轮接一轮自动续跑**，直到 `loop_done`（完成）、轮次预算耗尽（自动 `block`）、`loop_cancel`（取消）或用户中断。
- **Client 半（浏览器 UI）**：侧边栏 GitHub 按钮（Octocat 图标）→ 双标签插件发现（项目搜索 / 插件搜索 + AI 安装）；右键原生"添加工作区"按钮 → 粘贴路径注册工作区。

## 具体优化细节

### ① 自主循环（Claude Code 同款 loop）

- 四个模型工具：`loop_start` / `loop_status` / `loop_done` / `loop_cancel`。
- **轮次预算**：`max_rounds`（默认 20），到顶自动 `block(round-limit)`，防失控空转。
- **原子检查点**：每个 loop 一份 JSON 检查点（临时文件 + fsync + rename 原子发布），插件启动自动恢复，会话 resume 后 armed 循环自动续跑——重启/崩溃无需手动干预。
- **竞态围栏**（复用官方 `dsh-goal-round-driver` 模式）：`agent/status` idle 驱动下一轮；`agent/inbox/inserted` 检测竞争提示自动暂停；`agent/pre-step` waterfall 校验轮次预约（round 编号/内容/loop 身份），拒绝陈旧或外来轮次并归还其它已认领消息；`turn/end` aborted/max-tokens、`agent/error`、卸载时全部正确清理。
- **权限模型**：`loop_start` 仅直接人类轮（顶层 agent + 本轮含 `source.kind === 'user'` 消息），拒绝子代理；`loop_done`/`loop_cancel` 仅人类轮或当前循环轮。
- **重放安全**：轮次计数以会话日志中已 admit 的 loop 轮次（`user/message` + `source.kind === 'loop'`）为准，检查点只作提示，重放同一事件序列得到同一状态。
- 与内置 goal 系统并存：goal 是官方事件溯源续跑；dsh-do 是自包含、无事件溯源依赖的独立循环，建议一个任务只用一种机制。

### ② 侧边栏插件发现（GitHub）

- 入口挂在官方 `sidebar.footer.action` slot：**GitHub Octocat 图标**（内联 SVG），窄侧边栏只显图标、宽侧边栏图标 + 文字。
- **双标签**：
  - **「项目」**：通用 GitHub 项目搜索——输入任何关键词自由搜索（不加任何前缀），结果只浏览（仓库名/星数/描述），**不含安装**。
  - **「插件」**：GitHub 插件搜索——留空浏览 `dsh-plugin` 相关仓库，结果带 **AI 安装**按钮。
- **自由关键词**：任何输入都按原词搜索 GitHub（`topic:`/`dsh-plugin` 前缀只在留空浏览时作为默认查询），因此能搜到 Deepseek-Harness-EAC 这类**没打标签**的仓库。

### ③ AI 一键安装

- 插件结果每条带 **AI 安装**按钮：点击 → host 端 `POST /dsh-do/ai-install` → 创建**全新会话**并注入安装提示词 → 新会话出现在侧边栏列表，agent 自动开始安装。
- 安装提示词内置**校验步骤**：先确认 `dsh.bundle` 与产物完整可加载，再 `dsh plugin --profile web add github:<owner>/<repo>`，最后验证 `--dump-config` 并提示是否需要重启。
- 新会话自动继承部署环境事实：模型路由（默认模型选择 → 兜底 live agent）+ 工作目录（live agent 会话 cwd → 部署工作区根 → 主目录），persona 的 `{{model}}`/`{{cwd}}` 不缺值。

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
- 纯函数可测试：loop 状态机、提示渲染、检查点往返/原子性（`node --test` 15 个用例）。

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

`cordis.patch.yml` 中的 `config`（整段替换语义，覆盖时需重述全部键）：

| 键 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `defaultMaxRounds` | number | `20` | `loop_start` 省略 `max_rounds` 时的轮次预算 |
| `checkpointDir` | string | `""` | 检查点目录；空串 = `$DSH_HOME/loops`（`DSH_HOME` 未设置时为 `~/.dsh/loops`） |
| `persist` | boolean | `true` | 置 `false` 仅内存保存（不落盘） |

## 工具

| 工具 | 用途 | 权限 |
| --- | --- | --- |
| `loop_start { objective, max_rounds? }` | 启动循环；已有 active 循环时：armed → 报错，disarmed → 重新 arm（沿用已存 objective） | 仅直接人类轮；拒绝子代理 |
| `loop_status` | 读当前循环（id/objective/phase/armed/轮次/预算/原因） | 当前驱动内的调用 agent |
| `loop_done { summary? }` | 标记完成；循环轮内调用会注入 `<loop_complete>` 收尾提示 | 直接人类轮 **或** 当前循环轮 |
| `loop_cancel { reason? }` | 标记取消；同上注入 `<loop_cancelled>` 收尾提示 | 直接人类轮 **或** 当前循环轮 |

工具均要求：调用 agent 处于活跃驱动、当前 turn 未关闭（复用官方 `dsh-tool-goal` 的权威校验模式）。

## 开发与验证

```sh
pnpm install
pnpm typecheck      # host + client 双 tsc --noEmit
pnpm build          # build:host（tsc）+ build:client（tsc + tsdown → lib/client.js）
pnpm test           # build:host + node:test（loop 状态机/提示/检查点，15 个用例）
pnpm watch          # tsdown --watch（client HMR 构建）
```

已在本仓库验证：`typecheck`、`build`、`node --test`（15 个用例）、真实组合验证
（`dsh plugin --profile <scratch> add <tarball|github>` → `--dump-config` 出现 `dsh-do` 行 →
全新 profile 完整 boot 无 fiber/加载错误；client bundle 为 `window.__ModuleLoader__.load({...})`
包装，`/dsh-do/ai-install` 路由注册成功）。

**端到端 loop 验证**（需要模型凭证）：

```sh
npx -p @deepseek-ai/dsh dsh --profile web "用 loop_start 启动一个循环，目标：打印三行 hello；max_rounds 设 2；完成后调用 loop_done"
```

预期：第一轮完成打印 → 驱动自动队列第 2 轮 → 模型 `loop_done` → 循环 phase=completed，
`$DSH_HOME/loops/loop-*.json` 出现终止记录。

**浏览器 UI 验证**：重启 web profile 后：
1. 侧边栏底部出现 GitHub 图标 → 点开面板 → 「项目」通用搜索 / 「插件」搜索 + AI 安装；
2. 插件条目点「AI 安装」→ 侧边栏出现 `dsh-do-install-*` 新会话自动安装；
3. 右键侧边栏"添加工作区"按钮 → 粘贴路径 → 回车 → 工作区出现在侧边栏。

## 已知限制

- **GitHub 搜索**走公开 API，未带 token 时有速率限制（约 10 次/分钟）。
- 右键添加工作区通过 `aria-label` 匹配现有按钮（中/英），官方若改文案需同步更新选择器。
- 一个会话同时只允许一个 active 循环（需先 `loop_cancel` 或等其结束）。
- 检查点文件为单进程 last-write-wins（与官方 `dsh-storage-json` 同语义）；多进程写同一 root 不保证。
- `roundsStarted` 以会话日志为准；无持久化后端的会话在重启后不会自动续跑（新会话 id 与已存 loop 不匹配，属预期）。
- 模型必须遵守"达成目标就 `loop_done`"，预算耗尽只是兜底；与 goal 工具一样依赖模型的完成判断。
