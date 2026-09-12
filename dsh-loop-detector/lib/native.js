/**
 * Optional native adapter for the loop detector.
 *
 * The standard facet remains read-only. This bridge lets a host implementation
 * wire in cancel/retry actions that can actually affect live agents.
 */
const listeners = new Set();
let bridge;
/** Subscribe to native-mode loop detections. Returns an unsubscribe function. */
export function onNativeLoopDetected(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
/** Emit a detection to any registered native listeners. */
export function emitNativeLoopDetected(record) {
    for (const listener of listeners) {
        listener(record, bridge ?? { actions: {} });
    }
}
/** Register a host-provided native actions bridge. */
export function registerNativeLoopDetectorBridge(actions) {
    bridge = { actions };
    return bridge;
}
/** Read the currently registered bridge, if any. */
export function getNativeLoopDetectorBridge() {
    return bridge;
}
/** Unregister all listeners. Mostly useful in tests. */
export function clearNativeLoopDetectorListeners() {
    listeners.clear();
}
//# sourceMappingURL=native.js.map