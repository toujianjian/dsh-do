# DSH Loop Detector Plugin

自动检测 DeepSeek Harness 中的模型自循环，并在达到重试上限后终止异常请求。

## 功能

- 监控每个 agent 的输出内容
- 检测重复的长文本片段
- 当检测到循环时自动重试对应请求
- 重试仍失败时终止对应的 agent 请求
- 支持自定义重试次数、重试间隔与重试提示语
- 可配置的检测阈值和参数

## 配置

在 `cordis.patch.yml` 中可以配置以下参数：

- `enabled`: 是否启用插件，默认 `true`
- `threshold`: 重复次数阈值，默认 `3` 次
- `maxRepeatLength`: 重复文本的最小长度，默认 `100` 字符
- `checkInterval`: 检查间隔，默认 `5000` 毫秒
- `retry.enabled`: 是否启用模型重试，默认 `true`
- `retry.maxRetries`: 最大重试次数，默认 `3`
- `retry.retryDelayMs`: 首次重试延迟，默认 `1000` 毫秒
- `retry.backoffMultiplier`: 退避倍数，默认 `2`
- `retry.retryPrompt`: 重试时发送给模型的提示语，可自定义

## 安装

```sh
pnpm add ./dsh-loop-detector
```

或者从 GitHub 仓库安装：

```sh
npx -p @deepseek-ai/dsh dsh plugin --profile web add github:toujianjian/dsh-do
```

然后在你的 profile 中添加该插件：

```sh
dsh plugin --profile <your-profile> add dsh-loop-detector
```

## 说明

检测到自循环后，插件会先按配置向同一 agent 发送一次带重试提示的 follow-up；如果达到重试上限，则会终止当前请求。