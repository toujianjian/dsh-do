/**
 * Optional native adapter for the loop detector.
 *
 * The standard facet remains read-only. This bridge lets a host implementation
 * wire in cancel/retry actions that can actually affect live agents.
 */

import type { LoopDetectionRecord } from './index.js'

export interface NativeLoopDetectorActions {
  cancel?(record: LoopDetectionRecord): void | Promise<void>
  retry?(record: LoopDetectionRecord): void | Promise<void>
}

export interface NativeLoopDetectorBridge {
  readonly actions: NativeLoopDetectorActions
}

type Listener = (record: LoopDetectionRecord, bridge: NativeLoopDetectorBridge) => void

const listeners = new Set<Listener>()
let bridge: NativeLoopDetectorBridge | undefined

/** Subscribe to native-mode loop detections. Returns an unsubscribe function. */
export function onNativeLoopDetected(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Emit a detection to any registered native listeners. */
export function emitNativeLoopDetected(record: LoopDetectionRecord): void {
  for (const listener of listeners) {
    listener(record, bridge ?? { actions: {} })
  }
}

/** Register a host-provided native actions bridge. */
export function registerNativeLoopDetectorBridge(actions: NativeLoopDetectorActions): NativeLoopDetectorBridge {
  bridge = { actions }
  return bridge
}

/** Read the currently registered bridge, if any. */
export function getNativeLoopDetectorBridge(): NativeLoopDetectorBridge | undefined {
  return bridge
}

/** Unregister all listeners. Mostly useful in tests. */
export function clearNativeLoopDetectorListeners(): void {
  listeners.clear()
}
