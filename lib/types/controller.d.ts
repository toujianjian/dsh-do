import type { LoopStore } from './checkpoint.js';
import { type LoopState } from './loop.js';
/** Minimal logger surface the controller depends on. */
export interface LoopLogger {
    info(message: string): void;
    warn(message: string): void;
}
/** Error codes surfaced to tools and the driver. */
export declare const LOOP_ERROR: {
    readonly ALREADY_ACTIVE: "LOOP_ALREADY_ACTIVE";
    readonly NOT_ACTIVE: "LOOP_NOT_ACTIVE";
};
/**
 * Session-keyed loop registry. One loop per session; `start` creates a fresh
 * loop, re-arms a disarmed active loop, or replaces a terminal one.
 */
export declare class LoopController {
    private readonly store;
    private readonly logger;
    private readonly loops;
    constructor(store: LoopStore | undefined, logger: LoopLogger);
    /** Load persisted loops into the registry. Idempotent; call once at startup. */
    restore(): Promise<void>;
    get(sessionId: string): LoopState | undefined;
    /** Create a fresh loop, or re-arm a disarmed one. Terminal loops are replaced. */
    start(sessionId: string, objective: string, maxRounds: number): LoopState;
    /** Mark the loop completed and disarm it. */
    complete(sessionId: string, summary?: string): LoopState;
    /** Mark the loop blocked and disarm it. */
    block(sessionId: string, code: string, message: string): LoopState;
    /** Mark the loop cancelled and disarm it. */
    cancel(sessionId: string, reason?: string): LoopState;
    /** Arm or disarm the loop without changing its phase. */
    arm(sessionId: string, armed: boolean): LoopState | undefined;
    /** Bump the highest admitted round and persist. */
    recordAdmitted(sessionId: string, loopId: string, round: number): void;
    private requireActive;
    private commit;
}
