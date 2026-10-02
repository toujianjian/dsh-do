import type { LoopStore } from './checkpoint.js';
import { type LoopPauseReason, type LoopState } from './loop.js';
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
 * Sink notified after any commit that leaves an **armed active** loop.
 *
 * Starting, replacing, or resuming a loop produces no agent lifecycle
 * transition of its own — a slash command runs without a turn, so the agent is
 * already idle and stays idle. The round-continuation driver wakes only on
 * lifecycle events, so without this signal a freshly armed loop sits at zero
 * started rounds until some unrelated event makes the agent idle again.
 * Claude Code's `/loop` states the contract plainly: run the prompt
 * immediately, don't wait for the first scheduled fire.
 */
export type LoopChangeNotifier = (loop: LoopState) => void;
/**
 * Session-keyed loop registry. One loop per session; `start` creates a fresh
 * loop, re-arms a disarmed active loop, or replaces a terminal one.
 */
export declare class LoopController {
    private readonly logger;
    private readonly loops;
    private store;
    private notifier;
    constructor(store: LoopStore | undefined, logger: LoopLogger);
    /**
     * Register the sink that wakes the driver whenever a loop becomes armed and
     * active. Passing `undefined` detaches it, so a disposed driver is never
     * called after teardown.
     * @param notifier - the change sink, or `undefined` to detach.
     */
    setNotifier(notifier: LoopChangeNotifier | undefined): void;
    /**
     * Swap the durable store, e.g. after the user changes `persist` or
     * `checkpointDir`. In-memory loops are untouched: a store swap changes where
     * subsequent writes land, not which loops exist. Passing `undefined` disables
     * persistence without dropping live state.
     * @param store - the next store, or `undefined` for memory-only operation.
     */
    useStore(store: LoopStore | undefined): void;
    /** Load persisted loops into the registry. Idempotent; call once at startup. */
    restore(): Promise<void>;
    get(sessionId: string): LoopState | undefined;
    /** Every live loop, for a status surface that has no session in hand. */
    list(): readonly LoopState[];
    /**
     * Start the session's loop. A terminal or disarmed loop is **replaced
     * outright**: `loop_start` and `/loop <objective>` both mean "run THIS
     * objective", so a paused loop must not silently keep its old text and
     * budget. An armed loop is never clobbered — inspect, edit, pause, cancel,
     * or let it finish first.
     *
     * Replacement mints a fresh loop id on purpose. Admitted rounds are counted
     * from session events tagged with that id, so a new id is what actually
     * resets the budget; it also invalidates any in-flight reservation still
     * carrying the old id, so a queued round from the previous loop can never be
     * admitted into the new one.
     */
    start(sessionId: string, objective: string, maxRounds: number, intervalMs?: number): LoopState;
    /**
     * Replace the active loop's objective in place, keeping its phase, arming,
     * admitted rounds and cadence. This is the mid-flight correction path: use it
     * when the budget already spent should still count, whereas `start` replaces
     * the loop and resets the budget.
     */
    editObjective(sessionId: string, objective: string): LoopState;
    /** Mark the loop completed and disarm it. */
    complete(sessionId: string, summary?: string): LoopState;
    /** Mark the loop blocked and disarm it. */
    block(sessionId: string, code: string, message: string): LoopState;
    /** Mark the loop cancelled and disarm it. */
    cancel(sessionId: string, reason?: string): LoopState;
    /**
     * Arm or disarm the loop without changing its phase. Disarming records why,
     * so an active-but-stopped loop can explain itself.
     * @param reason - cause of the disarm; omitted only when re-arming.
     */
    arm(sessionId: string, armed: boolean, reason?: Omit<LoopPauseReason, 'at'>): LoopState | undefined;
    /** Bump the highest admitted round and persist. */
    recordAdmitted(sessionId: string, loopId: string, round: number): void;
    /** Record why an already-disarmed active loop stopped. */
    recordPaused(sessionId: string, reason: Omit<LoopPauseReason, 'at'>): LoopState | undefined;
    private requireActive;
    private commit;
}
