import { registerNativeLoopDetectorBridge, runNativeLoopRetryBridge } from './lib/native.js'

const record = { scope: 's1', detectedAt: Date.now(), repeatingSegments: ['a'.repeat(120)], recentTexts: [] }

function runCase(maxRetries) {
  let retries = 0
  let cancels = 0
  const bridge = registerNativeLoopDetectorBridge(
    {
      retry: () => { retries += 1 },
      cancel: () => { cancels += 1 },
    },
    { maxRetries, retryDelayMs: 0, backoffMultiplier: 1 },
  )
  return runNativeLoopRetryBridge(record, bridge).then((result) => ({ retries, cancels, result }))
}

const cases = [0, 1, 2, 3]
for (const maxRetries of cases) {
  const { retries, cancels, result } = await runCase(maxRetries)
  console.log(JSON.stringify({ maxRetries, retries, cancels, result }))
}

console.log('retry bridge self-test passed')
