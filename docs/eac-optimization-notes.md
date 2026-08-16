# Deepseek-Harness-EAC 改进优化建议

> 针对 [zouyuxuan122/Deepseek-Harness-EAC](https://github.com/zouyuxuan122/Deepseek-Harness-EAC)（v1.0 → v2.0.3，251★）的一期改进建议。
> 立场：**配合而非超越**——认可"Windows 开箱即用桌面封装 + 内置插件/皮肤/市场"的方向，只围绕稳定性、工程化、与官方 DSH 生态对齐提建议。优先级 P0（必做）/P1（建议）/P2（加分）。

---

## 一、项目亮点（建议保留的方向）

- 免装 Node、双击即用、便携版 + 安装版双形态：这是 DSH 桌面化的正确切法。
- 10 款皮肤、插件市场、会话文件追踪、余额小部件、任务通知、Codex/Claude Code 迁移：覆盖了从"装得上"到"用得爽"的完整链路。
- 三个社区 agent preset（`~/.dsh/.agent-presets`，preset.yml + agent.cordis.yml）完全符合官方 preset 规范。
- v2.0.x 的修复质量高：MAX_PATH 审计、更新器网络层换 Electron `net`、soul-md 坏行自愈——方向都对。

---

## 二、P0 —— 先堵住"起不来"和"装完崩"的面

### 1. 启动 fail-soft：单个插件坏 ≠ 整个 profile 崩

v2.0.1 的崩溃（soul-md 的 `config.path` 必填但行没带 config → 插件树加载失败 → 后端直接退出）暴露了一个系统性风险：**任意一个 bundle 的 schema 校验失败 = 整个应用打不开**。用户视角是"装了插件就再也起不来"。

建议：
- **启动前预检**：加载前逐个读 bundle 的 `Config` schema（schemastery），对每个行跑一次校验，坏行**降级为告警 + 跳过**（或进"禁用列表"），而不是让 Loader 整树失败。
- **安全模式**：桌面端提供"安全启动"（临时用空 profile patch 覆盖 / `--patch` 空层），保证任何插件炸了都能进去修。
- **健康自检页**：启动时记录每个 bundle 行 load/init 成败，失败原因写入统一日志（见 P1-9），UI 可一键查看/禁用坏行。

### 2. 包管理统一：不要 npm / pnpm 混用（当前最大的隐性坑）

marketplace 的 host 半边用**子进程 npm** 往 profile 装包，而官方 profile 是 **pnpm 布局**（`pnpm-workspace.yaml` + `pnpm-lock.yaml`，`@deepseek-ai/*` 走 `.pnpm/` 虚拟 store + 符号链接）。npm install 会：
- 生成 `package-lock.json`，并可能改写 node_modules 布局；
- 对 `@deepseek-ai/*` 的 hoisting/符号链接处理与 pnpm 不同 → 装完后**原有插件模块解析失败**（典型表现为"装了个市场插件，官方插件全 404"）。

建议：
- 市场安装统一走 pnpm（复用 profile 现有的 pnpm，或用 `dsh plugin --profile web add` 同款转发层），而不是裸 npm。
- 若必须保留 npm 路径：装完跑一次 `pnpm install --frozen-lockfile` 收敛布局，并做一次"装载前后 `--dump-config` 对比"自检。

### 3. 插件安装前健康预检（吸取"patch 指向缺失产物"的教训）

dshplugin.app 目录里已有插件出现 **`dsh.bundle.patch` 指向 `dist/cordis.patch.yml` 但仓库没提交构建产物** 的情况（Git 直装拿不到，profile 直接 ENOENT 起不来）。npm 市场同样可能遇到"字段齐全但产物缺失"的包。

建议 installPlugin 在装完后立即预检：
1. `package.json` 的 `main`/`exports["."].default` 存在且可 `import()`；
2. `dsh.bundle.patch` 指向的文件存在；
3. 行 id 无冲突（见 4）；
4. 预检失败 → 自动回滚（uninstall）+ 明确错误，而不是"装完即炸"。

### 4. 行 id 与 bundles 的幂等/冲突处理

- `ensureRow` 用 `pm-<slug>` 前缀是好习惯，但**已有同 id 行**（用户手改、别处安装、旧版本残留）仍会 duplicate loader entry id 崩溃（v2.0.1 修过一次市场场景）。
- 建议：安装前读整个 patch 文件按 `id` 建索引，冲突时换后缀（`pm-xxx-2`）或并入现有行；bundles 加入前去重（含大小写/scope 形式）。
- **并发写锁**：marketplace 与 CLI `dsh plugin` 可能同时写 `package.json` / `cordis.patch.yml`——加文件锁或队列（同一进程内串行 + 跨进程用锁文件）。

---

## 三、P1 —— 机制往官方接缝上靠

### 5. 皮肤切换：先走主题 token，再考虑改 patch

现在 skin-switch 是 host 侧 Typert Remote **重写 `cordis.patch.yml` 的 `ui-skin-*` 激活行** → 改文件 + 重启。风险：与其他行并发写、行 id 稳定性、重启打断会话。

建议分层：
- **纯外观层**（配色/圆角/密度）：优先用 DSH 主题 token（`--dsw-alias-*`）做 **client 端覆盖**（`dsh-client-ui-theme` 的主题切换机制），可即时切换、无重启、不碰配置文件；10 款皮肤中大部分应该能落到 token 覆盖层。
- 只有真正替换组件布局的皮肤才需要 patch 行；这类皮肤注册成**独立 client 插件**，切换走 client HMR（bundle 内容变化可 HMR，无需重启），避免每次改 patch。
- 无论哪种，写 patch 前先读-改-写串行化（同 P0-4）。

### 6. 插件市场数据源：npm search 关键词不可靠

`npm search keywords:dsh-plugin` 会漏掉大量不标 keywords 的插件（dshplugin.app 目录已聚合 225 个、带 manifest-valid 校验与 installCommand）。建议：
- 市场**混合数据源**：npm search + dshplugin.app 注册表（它已做 status/`manifest-valid` 校验），GitHub 源插件经 `git+https` 安装时明确标注"源码形态，需构建产物，可能不可用"。
- 安装命令统一交给 CLI 语义（`dsh plugin --profile web add ...`），EAC 只负责编排 + 结果展示。

### 7. 余额 / 任务通知：复用官方服务而非自研/桌面注入

- 余额 payload 由桌面 shell 推给页面：建议明确数据来源与刷新策略（`Cache-Control: no-store`、失败保留上次快照），并确认不把 API 凭证写进页面可读的日志。
- 任务完成通知：监听官方 `agent/*` 事件（`agent/turn-end` 或 session 事件）比轮询/桌面注入更稳；DSH 的 `ctx.tokenMeter` 可给 token 用量，作为余额/用量部件的权威来源。
- 会话内终端：官方已有 `ctx.terminals`（PTY 后端注册 + 会话绑定），复用比自研 PTY 省一半工作量且随官方演进。

### 8. soul-md 类第三方插件：去掉 vendored 运行时

`soul-md` 里 `vendor/dsh-settings-expose.js` 复制了官方 settings 包的部分实现——官方升级后容易漂移。建议：
- 改走 peer 依赖官方 `@deepseek-ai/dsh-settings`（settings 是正式 Service，client 端有 `dsh-client-ui-settings` 的 slot 接缝 `settings.section` / `settings.general.item`），不再复制运行时代码；
- 其 `config.path` 默认值问题：schema 里给默认值（`z.string().default('soul.md')`），而不是"启动时补行"这种自愈逻辑——从源头消除必填崩溃面（配合 P0-1 的双保险）。

---

## 四、P1 —— 更新与回滚

### 9. 更新前备份 + 失败回滚 + 诊断导出

- 更新（尤其跨大版本）前自动备份 `profiles/web`（package.json / cordis.patch.yml / node_modules 可由锁文件重建，重点备份 patch 与用户改动）+ `~/.dsh` 下非官方文件（soul.md、agent-presets 自定义、settings 覆盖）。
- 更新失败回滚：保留上一版安装目录（或便携版快照），启动自检失败自动回退。
- **诊断一键导出**：`%LOCALAPPDATA%\EAC\logs` + 崩溃转储 + profile 摘要（bundles、patch、dsh 版本）打包，用户反馈 #3/#4 这类问题直接给包，不用来回问。
- 更新包校验：除体积/MZ 头外，加固定 hash 或 Authenticode 签名校验（下载走 HTTPS + 系统代理已修，校验再上一个台阶）。

---

## 五、P2 —— 体验与安全加分项

- **首次启动向导**：选模型（DeepSeek API key 引导）/ 导入迁移 / 皮肤预览，一屏一步，别让用户对着空三栏发呆。
- **版本兼容矩阵**：内置 dsh CLI 版本 ↔ 内置插件版本 ↔ 市场插件的最低要求，更新前检查，避免"市场插件要求更高 dsh 版本"。
- **第三方插件安全提示**：npm 包的 `prepare` 会在安装时执行（marketplace 目前直接 npm install 就会跑）——市场 UI 标注来源/审查状态，安装前给风险提示；便携版别把凭证/密钥带进 U 盘场景。
- **插件市场收录自己的兄弟插件**：EAC 桌面 + DSH Web 可以互相配合——例如预装/推荐"发现类"插件（如 dsh-do 的 GitHub 搜索 + AI 安装助手），让用户在 EAC 市场之外也能发现 dshplugin.app / GitHub 上的插件，正好补强第 6 条的数据源短板。

---

## 六、与 dsh-do 的配合点（供参考）

dsh-do 目前提供：Claude Code 同款 loop、悬浮球插件发现（GitHub `dsh-plugin` 搜索 + AI 安装按钮）、右键粘贴路径添加工作区。与 EAC 配合的具体点：
1. **AI 安装按钮**正好补 EAC 市场的"发现 → 安装"链路：GitHub 上没进 npm 市场的仓库，EAC 市场搜不到，但 dsh-do 的 AI 安装会开新会话让 agent 验证并安装；
2. dsh-do 的安装提示词会先校验 `dsh.bundle`/产物完整性——和本建议 P0-3 的预检是同一思路，EAC 若愿意可直接在安装器里复用这套检查逻辑；
3. 两者的检查点/皮肤/市场都写 DSH 的配置与补丁文件，建议统一走"读-改-写串行化 + 行 id 幂等"约定，避免互相覆盖。

---

*生成时间：2026-08-15 · 基于 v1.0.0–v2.0.3 releases 与仓库源码分析*
