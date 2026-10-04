# Docker 验收环境（TUI 真实 TTY）

用来在**真实 pty** 里验收 TUI 的两件事：`/do-config` 的输出、`/status` 面板的 `◆ 循环` 段。
宿主机上没法可靠地做这件事（没有 pty、且会污染本机 profile），容器里可以。

容器刻意**对齐本机版本而不是 npm latest**，否则测的就不是用户实际在跑的那套：

| 组件 | 版本 | 为什么钉住 |
| --- | --- | --- |
| `@deepseek-ai/dsh` | `0.1.0-rc.8` | 本质检对象 |
| `@huiliyi37/dsh-tianshu-tui` | `0.1.1-rc.6` | npm latest 是 `1.0.0-rc.2`，与 rc.8 不兼容 |
| `@deepseek-ai/cordis-plugin-hmr` | `1.0.17` | `1.0.19` 删掉了 rc.8 依赖的 `registerConfig` |
| pnpm | `11.6.0` | 与本机一致 |

## 步骤

```sh
# 0. 起容器
docker run -d --name dsh-env -w /work node:24 sleep infinity
docker exec dsh-env npm i -g @deepseek-ai/dsh@0.1.0-rc.8 pnpm@11.6.0

# 每个脚本都这样送进去再跑（不要用 docker exec ... bash -c '<多语句>'：PowerShell 的引号会把脚本弄坏）
docker cp <脚本> dsh-env:/root/<脚本>
docker exec dsh-env bash -c 'bash /root/<脚本> > /tmp/out.txt 2>&1; echo rc=$?'
docker exec dsh-env cat /tmp/out.txt
```

| 脚本 | 作用 |
| --- | --- |
| `net-check.sh` | 网络体检：确认容器能不能连 npm / GitHub |
| `fix-hosts.sh` | 修容器内 `/etc/hosts`：宿主把 `github.com` 指到了 `127.0.0.1`，容器里那指向容器自身 |
| `rebuild-profile.sh` | 建 `/root/.dsh/profiles/tui` 并安装 dsh-base + tui + dsh-do（走文档里的 `github:toujianjian/dsh-do`） |
| `pin-tui.sh` | 用 `overrides` 钉住 hmr / tui 版本，写 `dsh.profile.bundles`，重装并重打 TUI 补丁 |
| `apply-patch-container.sh` | 应用 `scripts/patch-tui-status-panel.mjs` 并自检幂等/重复注入/语法 |
| `drive-tui.sh` | 驱动 `/do-config`（`/do-config` 验收的录制） |
| `verify-loop-section.sh` | 驱动 `/loop <目标>` + `/status`，抓 `◆ 循环` 段 |
| `extract-tui.sh` | 从录制里剥 ANSI 并抽取指定上下文（默认抓上次的 `tui-out.raw`） |
| `capture-do-config.sh [profile]` | 真实 PTY 里敲 `/do-config` 抓渲染：剥 ANSI 出"用户看到的样子"，并统计 `ESC[1m`/`ESC[2m` 证明 ANSI 属性真的透传。默认 profile `tui`（0.1.0-rc.8），可传 `v020`（0.2.0-rc.2）；会先按一次 Esc 关掉新版 TUI 的首启 API Key 模态 |
| `capture-config-panel.sh` | 同样方式抓 TUI 内置 `/config` 面板——用于证明它**只读**（无选择、无键盘导航、不调 `permission.set`），故插件不改它 |
| `raw-sgr.mjs <raw 文件> [锚点]` | 只看**锚点附近**的原始字节，把 ESC 显式标成 `<ESC>` 并统计该区域 SGR。**全文 SGR 计数不可用**——它被 TUI 自己的界面样式主导（状态栏/提示行/补全列表都在用 bold/dim），必须按区域看才能判断插件发出的样式有没有被 TUI 吞掉 |
| `vercmp.mjs` | 打印某目录下指定包的解析版本；对 hmr 额外检查有没有 `registerConfig` |
| `probe-env.sh` | 环境探针：各 profile 的版本组合、dsh-do 产物哈希、凭证现状、TUI 补丁状态 |
| `prepare-tui-test.sh` | 跑 tui profile 前的准备：备份并清除凭证、把全局 CLI 切到 `0.1.0-rc.8` |
| `mock-llm.mjs` | 本地 DeepSeek 兼容 SSE mock，按请求体里的轮次决定回复（第 3 轮回 `loop_done`） |
| `mock-patch.yml` | 把 `llm-deepseek` 的 baseURL 指到 mock（走 `--patch` 叠加，不动 profile 本体） |
| `mock-selftest.sh` | mock 自检：健康检查、普通请求、第 3 轮（应回 `loop_done`）、收尾请求——跑 4 分钟验收前先过这一关 |
| `mock-llm-fallback.mjs` | 模型自动切换专用的 mock：**主模型一律 429、其它模型 200**，200 的回复里自报模型名 |
| `mock-fallback-patch.yml` | 打开 `modelFallback` 的覆盖层（候选 `deepseek-official/deepseek-v4-pro`） |
| `verify-model-fallback.sh` | **模型自动切换验收**：对照组（开关关，应报错）＋ 实验组（开关开，应切换） |
| `verify-loop-multiround.sh` | **真实多轮循环验收**：TUI 里 `/loop 1m <目标>`，靠 mock 跑到第 3 轮由 `loop_done` 收尾 |
| `dump-loop-evidence.sh` / `decode-session-frames.sh` | 落盘证据：检查点、会话日志（多帧 zstd 必须逐帧解码，见下） |
| `restore-container.sh` | 把为测试改动过的容器恢复原样（凭证文件、全局 CLI 版本） |

**跑 TUI 前先断网**，否则 TUI 会自我升级到 latest 把环境弄坏：

```sh
docker network disconnect bridge dsh-env
docker exec dsh-env bash -c 'bash /root/verify-loop-section.sh > /tmp/x 2>&1'
docker network connect bridge dsh-env
```

TUI 用 `script -q -c "stty rows 50 cols 130; dsh --profile tui" <录制文件>` 起，输入经 `mkfifo` 喂进去；`stty` 那步是为了让面板拿到足够宽的行宽。

## 真实多轮循环（mock LLM，2026-10-04）

容器没有真实凭证，循环第 1 轮就会因 `llm-deepseek: no API key` 报错暂停——「一轮轮跑下去」和 `loop_done` 收尾永远测不到。真实凭证会烧额度，而且容器必须联网，联网又会让 TUI 自我升级把 profile 弄坏。

解法：**把 provider 的 baseURL 指到容器内的 mock**。mock 跑在 localhost，所以容器可以一直断网。

```sh
# 1) 准备：清凭证（rc.8 要求 version 是字符串，0.2.0 写的数字会打掉 profile 启动）+ 切全局 CLI
docker exec dsh-env bash /root/prepare-tui-test.sh

# 2) 断网（防自我升级），跑多轮验收
docker network disconnect bridge dsh-env
docker exec dsh-env bash /root/verify-loop-multiround.sh

# 3) 恢复
docker network connect bridge dsh-env
docker exec dsh-env bash /root/restore-container.sh
```

三个关键点：

1. **endpoint 走 `--patch` 覆盖层**，不改 profile 本体：`dsh --profile tui --patch /root/mock-patch.yml`，内容为 `- id: llm-deepseek` + `config.baseURL: http://127.0.0.1:8899`。
2. **凭证用继承的环境变量**（`DEEPSEEK_API_KEY=dummy-mock-key`）。`dsh-credentials-local` 的优先级是「继承进程环境（胜出）> `$DSH_HOME/.credentials.yaml` > `cwd/.env` > `$DSH_HOME/.env`」。
3. **轮次判定靠请求体里的 `<loop_round>`**（`renderLoopRoundPrompt` 渲染的 `Round: N/M`），所以 mock 不需要猜，也不用数请求（会话标题生成会插进来干扰）。

mock 的 wire 契约（照 `dsh-llm-deepseek` 实现写）：`POST {baseURL}/chat/completions`，`stream: true`，SSE 每行 `data: {...}`、末行 `data: [DONE]`；chunk 形如 `{choices:[{delta:{content|tool_calls},finish_reason}]}`；`finish_reason` 只认 `stop` / `tool_calls` / `length`。

**TUI 最短节奏是 1 分钟**（`MIN_INTERVAL_MS = 60000`，写 `30s` 会被抬上去），所以 3 轮约 2 分钟。

### 会话日志是多帧 zstd（重要）

`session.jsonl.zstd` 每次 append 写**一个独立 zstd 帧**。Node 的 `zstdDecompressSync` 和 `createZstdDecompress` **都只解第一帧**，直接整文件解压只会得到 1 个事件（那个 session 头），极易误判成「日志是空的 / 格式变了」。正确做法：按 magic `28 B5 2F FD` 切帧后逐帧解压——见 `decode-session-frames.sh`。

## 模型自动切换（对照实验，2026-10-04）

验 `modelFallback`：同一个 mock 让**主模型一律 429、其它模型 200**，两组之间唯一变量是开关。

```sh
docker exec dsh-env bash /root/prepare-tui-test.sh
docker network disconnect bridge dsh-env
docker exec dsh-env bash /root/verify-model-fallback.sh   # 对照组 + 实验组，约 3 分钟
docker network connect bridge dsh-env
docker exec dsh-env bash /root/restore-container.sh
```

要点：

1. **429 响应体别带 quota 字样**。provider 的 `httpErrorCode()` 会把 `[error.code, error.type, error.message]` 拼起来**先**判 `isQuotaExceededError()`，命中就变成 QUOTA 码，RATE_LIMIT 路径就测不到了。
2. **要等官方重试跑完**。`RATE_LIMIT` 是可重试码，`dsh-llm-retry` 默认 `maxRetries=5`、初始 500ms 指数退避（0.5+1+2+4+8 ≈ 15.5s），dsh-do 只在它放弃后才切换。所以脚本里单轮要留够 ~40s。
3. **让回复自报模型名**。切换是请求层的，TUI 状态栏仍显示会话选的模型；把模型名写进 200 的回复文本，界面就成了证据。
4. **一定要有对照组**。只跑实验组证明不了是 fallback 起作用。

## 踩过的坑（都是环境问题，不是本插件的缺陷）

1. **容器连不上 GitHub**：宿主 hosts 把 `github.com` 指到 `127.0.0.1`，Docker 会照抄。容器里那是容器自己 → 必然失败。`codeload.github.com` 没被屏蔽（返回 301），所以只有 git 路径受影响。
2. **`dsh plugin add` 非 0 退出，且 `dsh.profile.bundles` 还是空的**：新版 pnpm 的 `ERR_PNPM_IGNORED_BUILDS` 会让安装失败，而 `dsh plugin` 只在成功后写 bundles → 依赖装了、插件却不挂载，表现为启动时 `user patch-layer watching requires the Cordis HMR service`。
3. **全新 profile 起不来**：pnpm 解析出 `cordis-plugin-hmr@1.0.19`，该版本没有 `registerConfig`，而 dsh 0.1.0-rc.8 需要它 → 用 `overrides` 钉回 `1.0.17`。
4. **TUI 自我升级**：`dsh-tianshu-tui` 会把自己升到 npm latest（`1.0.0-rc.2`），而它跟 rc.8 不兼容，升完 profile 直接起不来。`overrides` + 断网双保险。
5. **不要用 `docker exec ... bash -c '<多语句>'`**：PowerShell 传参会把引号/转义弄坏，实测多次返回空输出、甚至把 `package.json` 写成残缺内容。一律用脚本文件 + `docker cp`。
6. **profile 里的 dsh-do 是旧 tarball → 被版本闸门静默跳过**（0.2.x 上尤其坑）：`dsh --profile v020 --dump-config` 会打 `skipping profile bundle "dsh-do"`，但 TUI 照常起得来，只是 `/do-config` 与 `/loop` 一起消失；又因为命令没注册，敲 `/do-config` 会被当成普通消息发给模型（看到「⠋ 理解」+ API 报错），极像"命令坏了"。**换构建后必须重装**（`dsh plugin --profile v020 add <新 tarball>`），只 `docker cp` 一个 `lib/index.js` 是不够的——`package.json` 的 `peerDependencies` 决定闸门放不放行。
7. **全局 CLI 版本要和 profile 对齐**：全局 `dsh` 是 0.2.0-rc.2 时跑 0.1.0-rc.8 的 `tui` profile，闸门会把该 profile 的插件行**全部禁用**（`disabling profile plugin row …`），profile 直接起不来。跑 0.1.x profile 前先用 `prepare-tui-test.sh` 把 CLI 切到 `0.1.0-rc.8`，跑完用 `restore-container.sh` 切回。

## 这一环境抓到的问题

`/status` 的 `◆ 循环` 段在循环运行时会**打崩整个 TUI 进程**（`TypeError: text is not iterable`，抛在渲染定时器里）。根因与修复见 `docs/loop-status.md` 的 "Docker 自测" 一节。修复后容器里复测通过：

```
◆ 循环 · 已暂停
验证状态栏循环段
↻ 轮次 1/20
⏸ agent-error · the agent reported an error while the loop was running
```
