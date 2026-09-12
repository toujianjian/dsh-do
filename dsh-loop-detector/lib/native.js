/**
 * Optional native adapter for the loop detector.
 *
 * The standard facet remains read-only. This bridge lets a host implementation
 * wire in cancel/retry actions that can actually affect live agents.
 */
const listeners = new Set();
let bridge;
let settings = {
    maxRetries: 3,
    retryDelayMs: 0,
    backoffMultiplier: 2,
};
/** Read the currently configured retry settings. */
export function getNativeLoopDetectorSettings() {
    return settings;
}
/** Update retry settings. This is the intended host/settings hook. */
export function configureNativeLoopDetector(partial) {
    settings = {
        maxRetries: partial.maxRetries ?? settings.maxRetries,
        retryDelayMs: partial.retryDelayMs ?? settings.retryDelayMs,
        backoffMultiplier: partial.backoffMultiplier ?? settings.backoffMultiplier,
    };
    return settings;
}
/** Subscribe to native-mode loop detections. Returns an unsubscribe function. */
export function onNativeLoopDetected(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
/** Emit a detection to any registered native listeners. */
export function emitNativeLoopDetected(record) {
    for (const listener of listeners) {
        listener(record, bridge ?? { actions: {}, options: settings });
    }
}
/** Register a host-provided native actions bridge. */
export function registerNativeLoopDetectorBridge(actions, options = {}) {
    bridge = {
        actions,
        options: {
            maxRetries: options.maxRetries ?? settings.maxRetries,
            retryDelayMs: options.retryDelayMs ?? settings.retryDelayMs,
            backoffMultiplier: options.backoffMultiplier ?? settings.backoffMultiplier,
        },
    };
    return bridge;
}
/** Read the currently registered bridge, if any. */
export function getNativeLoopDetectorBridge() {
    return bridge;
}
/** Reset retry counters. Mostly useful in tests. */
export function resetNativeLoopRetryAttempts() {
    // No cross-call retry accounting is kept; the bridge itself is bounded by the
    // configured maxRetries on each call.
}
/** Clear all listeners. Mostly useful in tests. */
export function clearNativeLoopDetectorListeners() {
    listeners.clear();
}
/** Helper: run a bounded retry loop for a single record. */
export async function runNativeLoopRetryBridge(record, bridgeOverride) {
    const current = bridgeOverride ?? getNativeLoopDetectorBridge();
    if (!current)
        return { retried: 0, canceled: false };
    const effective = {
        maxRetries: current.options.maxRetries ?? settings.maxRetries,
        retryDelayMs: current.options.retryDelayMs ?? settings.retryDelayMs,
        backoffMultiplier: current.options.backoffMultiplier ?? settings.backoffMultiplier,
    };
    let delay = effective.retryDelayMs;
    let retried = 0;
    let canceled = false;
    if (effective.maxRetries <= 0 || typeof current.actions.retry !== 'function') {
        return { retried: 0, canceled: await runCancel(current, record) };
    }
    for (let attempt = 0; attempt < effective.maxRetries; attempt += 1) {
        if (delay > 0)
            await sleep(delay);
        await current.actions.retry(record);
        retried += 1;
        delay = Math.round(delay * effective.backoffMultiplier) || effective.retryDelayMs;
    }
    if (!canceled) {
        canceled = await runCancel(current, record);
    }
    return { retried, canceled };
}
async function runCancel(current, record) {
    if (typeof current.actions.cancel === 'function') {
        await current.actions.cancel(record);
        return true;
    }
    return false;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=native.js.map