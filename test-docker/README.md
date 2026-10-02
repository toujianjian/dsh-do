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
| `vercmp.mjs` | 打印某目录下指定包的解析版本；对 hmr 额外检查有没有 `registerConfig` |

**跑 TUI 前先断网**，否则 TUI 会自我升级到 latest 把环境弄坏：

```sh
docker network disconnect bridge dsh-env
docker exec dsh-env bash -c 'bash /root/verify-loop-section.sh > /tmp/x 2>&1'
docker network connect bridge dsh-env
```

TUI 用 `script -q -c "stty rows 50 cols 130; dsh --profile tui" <录制文件>` 起，输入经 `mkfifo` 喂进去；`stty` 那步是为了让面板拿到足够宽的行宽。

## 踩过的坑（都是环境问题，不是本插件的缺陷）

1. **容器连不上 GitHub**：宿主 hosts 把 `github.com` 指到 `127.0.0.1`，Docker 会照抄。容器里那是容器自己 → 必然失败。`codeload.github.com` 没被屏蔽（返回 301），所以只有 git 路径受影响。
2. **`dsh plugin add` 非 0 退出，且 `dsh.profile.bundles` 还是空的**：新版 pnpm 的 `ERR_PNPM_IGNORED_BUILDS` 会让安装失败，而 `dsh plugin` 只在成功后写 bundles → 依赖装了、插件却不挂载，表现为启动时 `user patch-layer watching requires the Cordis HMR service`。
3. **全新 profile 起不来**：pnpm 解析出 `cordis-plugin-hmr@1.0.19`，该版本没有 `registerConfig`，而 dsh 0.1.0-rc.8 需要它 → 用 `overrides` 钉回 `1.0.17`。
4. **TUI 自我升级**：`dsh-tianshu-tui` 会把自己升到 npm latest（`1.0.0-rc.2`），而它跟 rc.8 不兼容，升完 profile 直接起不来。`overrides` + 断网双保险。
5. **不要用 `docker exec ... bash -c '<多语句>'`**：PowerShell 传参会把引号/转义弄坏，实测多次返回空输出、甚至把 `package.json` 写成残缺内容。一律用脚本文件 + `docker cp`。

## 这一环境抓到的问题

`/status` 的 `◆ 循环` 段在循环运行时会**打崩整个 TUI 进程**（`TypeError: text is not iterable`，抛在渲染定时器里）。根因与修复见 `docs/loop-status.md` 的 "Docker 自测" 一节。修复后容器里复测通过：

```
◆ 循环 · 已暂停
验证状态栏循环段
↻ 轮次 1/20
⏸ agent-error · the agent reported an error while the loop was running
```
