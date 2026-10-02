# dsh-DO：单一插件架构与整合记录

## 边界

分发单位只有根包 `dsh-do`；`cordis.patch.yml` 只有一个注册行（稳定 id `do`）。Host 与 Client 是同一插件的两端，不是两个安装项。保留历史 Host name `loop` 和工具名，避免无必要的身份兼容变动。

## 模块与数据流

| 内部模块 | 文件 | 所有权 / 职责 |
| --- | --- | --- |
| Host 组合入口 | `src/index.ts` | 必需 agents/tools/systemPrompt；创建 controller、驱动、工具、可选 HTTP 能力 |
| 循环状态机 | `src/loop.ts` | 状态、轮次、终止转换 |
| 状态协调 | `src/controller.ts` | 按 session id 管理循环，提交持久化 |
| 持久化 | `src/checkpoint.ts` | `$DSH_HOME/loops` 或显式目录；按文件串行原子写入 |
| 自动续跑 | `src/driver.ts` | 监听 agent/inbox/session；预约、校验、驱动下一轮 |
| 模型工具 | `src/tools.ts`、`src/prompt.ts` | 四个 loop 工具、权限判断、续跑/收尾提示 |
| 安装桥接 | `src/ai-install.ts` | POST 请求→独立工作区→新 agent 会话 |
| Client 入口 | `src/client/index.ts` | sidebar slot 与右键事件，生命周期释放 |
| 搜索 UI | `src/client/GitHubSearchButton.tsx` | GitHub 搜索、调用安装桥接 |
| 工作区 UI | `src/client/addWorkspace.ts`、`AddWorkspaceDialog.tsx` | 状态、服务绑定、目录注册 |

主流程：人类请求→loop_start→controller→checkpoint；agent idle→driver→下一轮消息→权限/预约校验→完成或预算终止。

## 本轮修复

1. 移除根 manifest/lock 中未使用的 `link:dsh-loop-detector`。发布白名单仅包含 lib/patch/README，本地链接既没有主入口调用，也不能作为可靠的 Git/tarball 安装依赖。
2. 检查点解析现在拒绝 null/非法 blockedReason、不安全文件 id、非有限时间戳；一个损坏记录不能中断其他记录的恢复。写入口同样约束文件 id。
3. 工作区服务绑定返回 disposer，由 Client fiber 持有；卸载时清空服务并关闭对话框，旧绑定不会清掉新服务。
4. 搜索组件 effect 每次挂载恢复 alive 标记，修复 React 重复 effect setup/cleanup 后结果无法更新的问题；补充 Escape 关闭和正确的项目空结果文案。
5. 测试入口统一覆盖 Host、Client 状态、包契约；完整构建更新提交式分发产物。

## 历史检测目录

`dsh-loop-detector/` 是仓库遗留实验源码，使用另一套 `@dsh-std/*` 协议。当前根 Host/Client 从未调用它，不能宣称它在自动检测或重试。保留源码以免丢失历史工作，但从主包运行依赖中移除；它不属于本插件的第二个安装项。

若要启用重复检测，应将纯算法作为 `src/` 内部模块接入现有 driver，并先确定重复阈值、触发时机和中止规则；不增加插件注册或依赖该实验 facet。现有算法只比较最后两条文本，threshold 并非重复次数，枚举公共子串的代价高，不宜直接接入生产。

## 第二轮稳定性修复

- 真实 Cordis 注册测试发现四个循环工具均未注册：输出 schema 的 required 错放在 oneOf 分支，defineTool 在运行时拒绝。已移至 loop 属性元数据；构建和纯状态测试不能替代运行时注册测试。
- driver 现在检查 inbox 已有 nextTurn，避免启动/恢复时越过用户消息；等待 pre-step 时新到的竞争消息也会否决旧轮次。14 项驱动测试覆盖取消、预算、竞态和卸载。
- 安装 HTTP 接口拒绝跨站 Origin/Fetch Metadata 及非 JSON 请求，缺少 preset 或工作区服务时提前返回 503。setup 失败回滚新注册工作区，followup 失败释放已创建 agent；仅删除空目录，保留可能已有的文件。
- 工作区对话框用打开状态身份与请求 token 隔离旧响应，防重复提交及关闭重开污染。
- GitHub 请求按项目/插件分通道取消旧请求，卸载取消；校验仓库名、GitHub HTTPS URL 与响应字段。
- pnpm test 先完整构建，再测试实际发布入口，避免只更新 lib/types 而测到旧 lib/index。

## 验证边界与后续风险

- 已核对：当前 web profile 的 dsh-do 安装产物与源码构建不同；重启未自动更新它。旧实例 GET 安装接口返回预期 405，不代表本轮修复已生效。
- 已执行临时 DSH_HOME 的 tarball 安装与 --dump-config，只有一个 do 注册行；安装报告 peer 提示，不能只凭配置打印断言完整运行成功。
- 真实 Cordis/ToolRuntime 及安装版 Loader 测试不使用模型凭证、不启动 Web：验证工具注册、prompt/事件清理、单行装配。Loader 测试通过 DSH_COMPOSITION_RUNTIME_MANIFEST 指定安装版 package.json；未设置时明确跳过。
- HTTP/驱动/Client 异步逻辑使用可控服务或状态测试；不等于浏览器 DOM、真实模型续跑或真实 GitHub 安装验收。
- 尚无 Playwright/jsdom 浏览器测试依赖，焦点管理、窄屏及真实 GUI 验收仍待完成。
- HTTP 防跨站不是认证系统；对外暴露须使用宿主访问控制。安装接口仍接受 prompt，未自动触发外部插件安装测试。
- lib 中残留 FloatingOrb/registry 历史产物未被当前入口引用。未来清理应先做干净目录构建和安装验证，不手工删除未知入口。

不自动迁移或删除任何用户循环检查点，不修改 profile，不提交或推送代码。
