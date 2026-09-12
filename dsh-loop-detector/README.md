# dsh-loop-detector

DSH Standard 组件，按 `messages.dsh/v1alpha1` 观察消息并检测模型自循环。标准 facet 只做检测与记录，同时提供一个可选 `./native` 适配层，方便宿主接入真正的 cancel / retry。

## 模式

### 标准模式

- 由 `@dsh-std/adapter-dsh` 发现并激活
- 不修改消息
- 贡献命令：
  - `loop-detector.status`
  - `loop-detector.clear`

### 宿主增强模式

宿主可导入 `dsh-loop-detector/native` 把检测事件接到本地 agent 操作：

```ts
import { registerNativeLoopDetectorBridge, configureNativeLoopDetector, onNativeLoopDetected } from 'dsh-loop-detector/native'

configureNativeLoopDetector({ maxRetries: 5, retryDelayMs: 200, backoffMultiplier: 2 })

registerNativeLoopDetectorBridge(
  {
    cancel: async (record) => await yourAgent.cancel(record.scope),
    retry: async (record) => await yourAgent.retry(record.scope),
  },
)

onNativeLoopDetected((record, bridge) => {
  void bridge.actions.cancel?.(record)
})
```

## 安装

标准组件：

```sh
dsh plugin --profile web add @dsh-std/adapter-dsh
dsh plugin --profile web add github:toujianjian/dsh-do
```

本地链接：

```sh
pnpm add ./dsh-loop-detector
```

## 使用

```sh
loop-detector.status
loop-detector.clear
```

## 校验

```sh
node scripts/validate-manifest.mjs --manifest ./dsh-plugin.json --grant messages.observe.read
```

## 许可证

MIT
