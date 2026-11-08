# 暴力测试（Docker）

对 dsh-do 的可达输入面做**机器化压力/畸形输入测试**，目标是让崩溃、挂死、越界接受和静默丢数据自己暴露出来，而不是靠人肉点按。Tier 1 全部在容器 `dsh-env` 里跑、不碰宿主机 profile；Tier 2 在容器里起一个**真实 web 部署**压它自己的设置路由，跑完自动还原 profile。

## 方法

| 套件 | 打的是什么 | 规模 |
| --- | --- | --- |
| `run-pure.mjs` | 所有导出的解析器 / 构造器 / 渲染器 / 状态机 / 投影 / 检测器 / 设置写入解析 | 29,886 次调用 |
| `run-store.mjs` | 检查点存储的真实文件系统行为：并发、体量、畸形目录布局、FIFO、SIGKILL、读写竞态、符号链接、id 遍历 | 12×60 并发写、4000 文件、40 次 SIGKILL、400 次竞态读 |
| `run-http.mjs` | `readJsonBody` 的敌意流（超大、分块、中断、非法 UTF-8/JSON）与真实设置路由处理器（假 Context 挂真 handler）的状态码矩阵、同源护栏、原型污染路径 | 13 个正例 + 300 次方法/头/体模糊 |
| `web-load.mjs`（Tier 2） | 真 web 部署上的并发读、revision 竞争写、同源/方法/类型/超大/未知 ns/原型路径滥用 | 250 并发读、200 写、10 轮 × 9 种滥用 |
| `repro-poison.mjs` | 畸形检查点如何连坐整个恢复流程 | 最小复现 |

判据不是"不抛异常"而已：**任何被接受的值都必须落在文档化的定义域内**（例如 `parseCheckpoint` 接受了 `armed` 的终态、越界的 `maxRounds`，就是 status 面板在说谎），所以套件同时校验定义域。

## 环境（一次性的版本 pin，重要）

`lib/types/*.js` 是**未打包**的产物，`settings.js` 直接从 `@deepseek-ai/dsh-settings` 具名导入 `deepEqualJson` / `settingsNamespace` / `installSettingsSection`。这三个符号在 **0.2.0-rc.2 里已不存在**（该版本只导出 `SettingsConflictError` / `SettingsForms` / `default` / `redactSecrets`）。发布包能跑，是因为 `lib/index.js` 是自包含 bundle（把这三个内联了）；但**深导入内部模块**（本套件、以及任何按目录导入 `lib/types/*` 的代码）必须配 rc.6 依赖。

因此容器里的做法是：在 `/root/brute-deps` 按 **rc.6** 装一份完整 peer 集（`dsh-settings` 自己的 import 也要从这里解析，所以不能只装它一个），再用 `setup-nm.sh` 以 `v020` profile 的 `node_modules` 为底、**只把 `@deepseek-ai/dsh-settings` 覆盖成 rc.6**：

```sh
# setup-deps.sh：npm i --legacy-peer-deps（不加会因 peer 冲突 ERESOLVE）
# setup-nm.sh  ：profile 树的软链 + 单个 dsh-settings 覆盖
```

## 跑

```sh
# 一次性：rc.6 依赖 + 混合 node_modules
docker cp test-docker/brute/. dsh-env:/root/brute/
docker cp test-docker/brute/setup-deps.sh dsh-env:/root/
docker cp test-docker/brute/setup-nm.sh dsh-env:/root/
docker exec dsh-env bash /root/setup-deps.sh      # 只与 npm 交互一次
docker exec dsh-env bash /root/setup-nm.sh        # 搭混合 node_modules（见上）

# 每次：同步产物并跑三个套件
docker cp lib/types dsh-env:/root/brute/lib/types
docker exec dsh-env bash /root/brute/run-all.sh   # 任一失败则非 0
```

`/tmp/all.out`（或 `run-capture.sh` 的产物）是完整回执；`node /root/brute/analyze.mjs /tmp/all.out` 汇总。每个套件最后打印一行 `BRUTE_* {...}` JSON（机器可读），失败时退出码 1。

## 结果（2026-11）

### 通过的（不变量成立，可作为回归护栏）

- **HTTP 面**：状态码分类全对（同源 GET 200、异源/null/cross-site 403、PUT 405、错误 content-type 415、坏 JSON/空 ops/超 64 KiB/超大 ops 数组 400、`SETTINGS_CONFLICT`→409 且回显机器码、`TypeError`→400、其它→500）；300 次方法/头/体模糊全部有响应且响应体是合法 JSON；`__proto__` / `constructor.prototype` 写入路径没有污染 `Object.prototype`；64 KiB 边界精确（65536 通过、65537 拒绝）；中途断流的请求体走拒绝而不是挂住。
- **存储**：同文件 60 轮×12 个循环并发写，最终文件可解析、最后写入胜出、无 `.tmp` 残留；4000 个循环 / 4000 个文件 load ≈ 0.8 s、堆 ≈ 10 MB；4M 字符 objective 往返无损；截断/空/二进制/NaN JSON/同名目录一律 `onError` 跳过不崩；写符号链接文件时替换链接本身、绝不写穿到目录外；**40 次写循环中途 SIGKILL → 0 次留下半截文件**；400 次"读并发写"快照全部一致；`../escape` 这类 id 被路径守卫拒绝。
- **纯函数**：29,886 次调用里，`/loop` 语法被约束在 `[60s, 2147483647ms]` 且 start 的 objective 永不为空；`displayWidth` 恒为有限非负整数（含 ANSI、组合符、lone surrogate）；`parseSettingsWriteRequest` 对 3000 个随机体从不抛错；`loopStatusView` / `renderLoopStatusLine` 对畸形循环状态从不抛错（这正是历史上 TUI 崩溃的位置）；状态迁移在 NaN/Infinity/负数轮次下都产生定义域内的状态。

### 已修复（本轮亲自改掉，附复测）

#### ~~1. 一个畸形检查点让所有循环都无法恢复~~（已修）

`parseCheckpoint` 的诊断信息会把未信任值交给 `String()`：

```ts
if (version !== 1) return { ok: false, error: `... unsupported version ${String(version)}` }  // 旧代码
```

当 `version` 带一个**非函数的自有 `toString`**（`{"toString":null}` / `{"toString":7}`）时，`String()` 抛 `TypeError`，逃出 `parseCheckpoint` → 逃出 `LoopStore.load()` → `restore()` 只打一条 warn，**其余健康检查点一个都不恢复**。注意：`{"toString": …}` 只遮蔽同名属性，真正致命的是值不是函数；同名 accessor 不会触发。

（`phase` 那几个字段一直是安全的：先 `typeof === 'string'` 判断，`String()` 走不到。）

**修法**（`src/checkpoint.ts`）：新增 `describeValue()`，只回显 JSON 标量，对象/数组只报种类（`an object` / `an array`），**永不触发用户态转换**；三处 `String()` 全部替换。另外在 `load()` 里把 `parseCheckpoint` 整个包进 try/catch 兜底——解析器再出任何意外也只丢掉那一个文件。

复测：`node repro-poison.mjs`

```
parse(version): returned {"ok":false,"error":"file loop-poison.json has unsupported version an object"}
load(): returned 1 loop(s): session-healthy
```

新增回归用例 `test/checkpoint.test.mjs`：
- `a checkpoint whose version cannot be stringified is skipped, not thrown`
- `checkpoint diagnostics describe hostile scalars without coercing them`

#### ~~2. 检查点目录里的 FIFO 会让恢复永久挂起~~（已修）

`load()` 对 `loop-*.json` 直接 `readFile`，不判类型：无写端的 FIFO 永不返回（`/dev/zero` 之类会无限读），而 `await restore` 在注册 `/loop`/循环工具**之前**，于是插件"静默半死"。

**修法**（`src/checkpoint.ts`）：读之前 `lstat`（不跟随符号链接），只接受 `isFile()`，否则 `onError` 跳过。符号链接同样被拒——它不是这个 store 写的，写穿过去还会落到目录外。

复测：`run-store.mjs` 的 `store.fifo` 由"挂死 5 s 超时"变为通过：

```
BRUTE_STORE {"ok":true,"failures":[]}
```

新增回归用例 `LoopStore ignores non-regular files instead of blocking on them`（目录 + 符号链接 + `mkfifo`，Windows 上符号链接/`mkfifo` 不可用时自动跳过）。

### 仍未修（低危，需你定夺）

#### 3. `canonicalizeArguments` 在深嵌套上栈溢出（低）

`load()` 对 `loop-*.json` 直接 `readFile`，不先判类型。一个没有写端的 FIFO（或 `/dev/zero` 之类的设备）会让它永远不返回；而 `index.ts` 里 `await restore` 在 `registerLoopTools` **之前**，于是 `/loop`、`loop_start/status/done/cancel` 全部不注册、驱动也不工作——插件"静默半死"，进程本身还活着。

套件里 5 s 超时判定：`store.fifo: load() blocks forever on a FIFO named loop-*.json`。同一根因下，一个 TB 级假文件也会被整个读进内存。

**修法**：`readdir` 后用 `lstat` 只接受普通文件（`isFile()`），或 `open` 加 `O_NONBLOCK`/`O_NOFOLLOW` 并校验；顺带给 `restore` 加超时。

#### 3. `canonicalizeArguments` 在深嵌套上栈溢出（低）

`sortJsonValue` 是递归的，5000 层就 `RangeError: Maximum call stack size exceeded`（实测 `JSON.parse` 能解析到 12000 层，所以这个输入**在模型侧是可达的**）。它跑在工具调用钩子里：一个嵌套极深的参数会抛 `RangeError` 而不是被当成"普通调用"处理。同一函数在 depth 20000 时先在 `JSON.stringify` 处炸。

**修法**：迭代式遍历，或设一个显式深度上限后直接返回"不可比较"标记（重复检测宁可退化为不检测，也不该抛）。

#### 4. `canonicalizeArguments` 对极少数畸形键**不幂等**（低，未定根因）

1500 个随机敌意值里有 2 个满足 `canonicalize(parse(canonicalize(v))) !== canonicalize(v)`，差异出现在键上（`"` vs `\` 一类）。后果是"同一调用重复 N 次"可能被判成不同调用，重复检测漏报。已保留见证，但尚未最小化到能定根因的形状；在真实工具参数里需要极端键名才触发。

### 信息性

- **`.tmp` 残留**：SIGKILL 打断原子写会留下 `.` 前缀的临时文件（实测每崩溃最多 1 个）。`load()` 会忽略，但从不清理；长时间反复崩溃会积累。
- **内部产物的版本偏斜**：见"环境"一节。发布 bundle 不受影响，但任何按目录深导入 `lib/types/*` 的代码（包括本套件）都必须配 rc.6 的 `dsh-settings`。
- **`root` 是普通文件时 `load()` 抛 `ENOTDIR`**：被 `restore()` 的 catch 兜住，表现为"没有循环"；属于配置错误，不算缺陷。

## 本轮修复后的复测（2026-11）

```
node --test test/*.test.mjs   → 219 用例 / 194 通过 / 0 失败 / 25 跳过（真实组合层，容器里跑）
run-pure.mjs                  → ok=false，仅剩 detect.deep(3) 与 detect.canonical(2)，即下面 #3/#4
run-store.mjs                 → ok=true（含 FIFO、SIGKILL、4000 文件、竞态）
run-http.mjs                  → ok=true
web-load.mjs（真实 web020）    → ok=true，250 并发读 250×200，服务在 90 次滥用后仍正常
```

## Tier 2：真实 web 部署（`web-load.mjs`）

```sh
# 1) 起 mock LLM + web（沿用已有脚本）
docker exec dsh-env bash /root/start-web020.sh
# 2) 压真实部署（profile 里装的 lib/index.js 与本仓库 lib 逐字节相同）
TOKEN=$(docker exec dsh-env bash -c 'grep -o "token=[A-Za-z0-9._-]*" /tmp/web-web020.log | head -1 | cut -d= -f2')
docker exec -e "TOKEN=$TOKEN" dsh-env bash -c 'cd /root/brute && node web-load.mjs'
# 3) 停服务；profile 未被修改（可用 restore-web.sh 复核）
docker exec dsh-env bash /root/restore-web.sh
```

结果（全部通过 `ok = true`）：

| 组 | 观测 |
| --- | --- |
| 认证 | 303 + cookie |
| 250 并发读 | 250×200，响应体全部是合法 JSON、`sections` 为数组 |
| 120 次过期 revision 写 | 120×500（宿主先拒），非 409——见下 |
| 80 次同 revision 竞争写 | 80×500（宿主先拒） |
| 滥用矩阵各 10 轮 | 415 / 400 / 400 / 400 / 403 / 403 / 500 / 500 / 405 / 405 / 405，全部符合预期 |
| 200 KB 超大 body | 400（不是 5xx，不挂死） |
| 尾声 | 服务仍 200，`do` 段仍在，revision 不变，进程 sleeping/11 线程 |

两个值得记下的观察：

1. **0.2.0-rc.2 上设置写入整体不可用**：所有 `POST` 都被宿主以 `500 dsh: profile reload requires the root Include entry` 拒绝。这是平台侧已知阻塞（`docs/verification.md` 第九轮），**不是本插件缺陷**；但它意味着在 0.2.x web 部署里，设置页能读不能存，而且 409/revision 围栏在这个部署上根本走不到。
2. **本部署里 dsh-do 的设置段名实际是 `do`，不是 `dsh-do`**。路由的 `READ_NAMESPACES` 白名单里写的是 `dsh-do`，所以这一段能出现在 GET 里靠的是 `isDoSection()` 形状兜底；页面用 `sections[i].ns` 回写所以还能对上。建议把白名单与实际段名对齐（或断言 `settingsNamespace()` 的真实取值），否则形状一变这段就静默消失。

## 边界

- Tier 1 覆盖进程内逻辑 + 真实文件系统 + 真实 HTTP handler；Tier 2 覆盖真实 web 部署的**读路径与错误路径**。**没跑**：TUI 的 `/status` 渲染（已有 `test-docker/verify-loop-*.sh`）、真实 LLM 的端到端循环。
- Tier 2 的写路径在 0.2.0 上被平台拦死，所以 409 / revision 围栏的真实并发行为只在 Tier 1 的假 settings 上验过。
- 恶意模型参数只按"JSON 域内"建模：BigInt、Symbol、getter 这类不可由 JSON 表达的值记为 note，不计失败。
- 深嵌套重复检测的**实际**触发概率很低；这里报告的是"可达即应不崩"，不是已被观测到的线上故障。
