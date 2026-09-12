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
export interface NativeLoopDetectorSettings {
    /** Maximum retry attempts before cancel. Default: 3. */
    maxRetries: number;
    /** Base delay in ms before the first retry. Default: 0. */
    retryDelayMs: number;
    /** Multiplier for delay between retries. Default: 2. */
    backoffMultiplier: number;
}
export interface NativeLoopDetectorBridgeOptions {
    /** Maximum retry attempts before cancel. Default: 3. */
    maxRetries?: number;
    /** Base delay in ms before the first retry. Default: 0. */
    retryDelayMs?: number;
    /** Multiplier for delay between retries. Default: 2. */
    backoffMultiplier?: number;
}
export interface NativeLoopDetectorBridge {
    readonly actions: NativeLoopDetectorActions;
    readonly options: Required<NativeLoopDetectorBridgeOptions>;
}
type Listener = (record: LoopDetectionRecord, bridge: NativeLoopDetectorBridge) => void;
/** Read the currently configured retry settings. */
export declare function getNativeLoopDetectorSettings(): NativeLoopDetectorSettings;
/** Update retry settings. This is the intended host/settings hook. */
export declare function configureNativeLoopDetector(partial: Partial<NativeLoopDetectorSettings>): NativeLoopDetectorSettings;
/** Subscribe to native-mode loop detections. Returns an unsubscribe function. */
export declare function onNativeLoopDetected(listener: Listener): () => void;
/** Emit a detection to any registered native listeners. */
export declare function emitNativeLoopDetected(record: LoopDetectionRecord): void;
/** Register a host-provided native actions bridge. */
export declare function registerNativeLoopDetectorBridge(actions: NativeLoopDetectorActions, options?: NativeLoopDetectorBridgeOptions): NativeLoopDetectorBridge;
/** Read the currently registered bridge, if any. */
export declare function getNativeLoopDetectorBridge(): NativeLoopDetectorBridge | undefined;
/** Reset retry counters. Mostly useful in tests. */
export declare function resetNativeLoopRetryAttempts(): void;
/** Clear all listeners. Mostly useful in tests. */
export declare function clearNativeLoopDetectorListeners(): void;
/** Helper: run a bounded retry loop for a single record. */
export declare function runNativeLoopRetryBridge(record: LoopDetectionRecord, bridgeOverride?: NativeLoopDetectorBridge): Promise<{
    retried: number;
    canceled: boolean;
}>;
export {};
