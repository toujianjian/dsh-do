import { registerNativeLoopDetectorBridge, runNativeLoopRetryBridge } from './lib/native.js'

const record = { scope: 's1', detectedAt: Date.now(), repeatingSegments: ['a'.repeat(120)], recentTexts: [] }
let retries = 0
let cancels = 0

const bridge = registerNativeLoopDetectorBridge(
  {
    retry: () => { retries += 1 },
    cancel: () => { cancels += 1 },
  },
  { maxRetries: 3, retryDelayMs: 0, backoffMultiplier: 1 },
)

runNativeLoopRetryBridge(record, bridge).then((result) => {
  console.log(JSON.stringify({ retries, cancels, result }))
  process.exit(0)
})
