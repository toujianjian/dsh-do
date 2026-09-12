/**
 * Optional native adapter for the loop detector.
 *
 * The standard facet remains read-only. This bridge lets a host implementation
 * wire in cancel/retry actions that can actually affect live agents.
 */
import type { LoopDetectionRecord } from './index.js';
export interface NativeLoopDetectorActions {
    cancel?(record: LoopDetectionRecord): void | Promise<void>;
    retry?(record: LoopDetectionRecord): void | Promise<void>;
}
export interface NativeLoopDetectorBridge {
    readonly actions: NativeLoopDetectorActions;
}
type Listener = (record: LoopDetectionRecord, bridge: NativeLoopDetectorBridge) => void;
/** Subscribe to native-mode loop detections. Returns an unsubscribe function. */
export declare function onNativeLoopDetected(listener: Listener): () => void;
/** Emit a detection to any registered native listeners. */
export declare function emitNativeLoopDetected(record: LoopDetectionRecord): void;
/** Register a host-provided native actions bridge. */
export declare function registerNativeLoopDetectorBridge(actions: NativeLoopDetectorActions): NativeLoopDetectorBridge;
/** Read the currently registered bridge, if any. */
export declare function getNativeLoopDetectorBridge(): NativeLoopDetectorBridge | undefined;
/** Unregister all listeners. Mostly useful in tests. */
export declare function clearNativeLoopDetectorListeners(): void;
export {};
