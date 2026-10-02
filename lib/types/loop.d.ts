import type { Agent } from '@deepseek-ai/dsh-agent';
/** Stable identity of one loop. */
export type LoopId = string & {
    readonly __loopId: unique symbol;
};
/** Mint a loop identity from its string form. */
export declare function LoopId(value: string): LoopId;
/**
 * Largest delay `setTimeout` accepts, and therefore the ceiling for a loop
 * cadence: a longer one could never be scheduled. Also bounds a persisted
 * `intervalMs`, so a hand-edited checkpoint cannot request an absurd pace.
 */
export declare const MAX_TIMER_DELAY_MS = 2147483647;
/** Lifecycle phase of a loop. */
export type LoopPhase = 'active' | 'completed' | 'blocked' | 'cancelled';
/** Structured reason a loop was blocked. */
export interface LoopBlockedReason {
    readonly code: string;
    readonly message: string;
}
/**
 * Why an active loop stopped continuing on its own. The driver disarms a loop
 * whenever the round it queued was rejected or the turn ended in a way the
 * harness believes should not be retried automatically, which is the same
 * contract the built-in goal driver follows. Recording the cause is what lets
 * a status surface explain a stop instead of leaving it silent.
 */
export type LoopPauseReasonCode = 'round-cancelled' | 'round-aborted' | 'max-tokens' | 'agent-error' | 'driver-failed' | 'restart';
/** A recorded stop, with the cause and when it was observed. */
export interface LoopPauseReason {
    readonly code: LoopPauseReasonCode;
    readonly message: string;
    /** Epoch ms the pause was recorded. */
    readonly at: number;
}
/**
 * Durable state of one Claude Code-style loop, owned by one session.
 * Every field is immutable; transitions return a new snapshot.
 */
export interface LoopState {
    readonly id: LoopId;
    /** The agent/session identity the loop rides on. */
    readonly sessionId: string;
    /** The concrete completion objective restated into every round prompt. */
    readonly objective: string;
    /** Cap on automatic continuation rounds. */
    readonly maxRounds: number;
    /**
     * Minimum delay between rounds in milliseconds, from `/loop <interval> …`.
     * Absent means the driver queues the next round as soon as the agent is
     * idle, which is the behavior of `loop_start`.
     */
    readonly intervalMs?: number;
    readonly phase: LoopPhase;
    /** Whether the driver may queue the next round automatically. */
    readonly armed: boolean;
    /**
     * Why an active loop is disarmed. Present only while `phase === 'active'`
     * and `armed === false`, i.e. exactly when a human cannot tell from the
     * loop's own output whether it is working or stopped.
     */
    readonly pausedReason?: LoopPauseReason;
    /** Highest round admitted into the session log, last known. */
    readonly roundsStarted: number;
    readonly blockedReason?: LoopBlockedReason;
    readonly completedSummary?: string;
    readonly cancelledReason?: string;
    readonly startedAt: number;
    readonly updatedAt: number;
}
/** Inputs for {@link createLoop}. */
export interface CreateLoopInput {
    readonly sessionId: string;
    readonly objective: string;
    readonly maxRounds: number;
    /** Optional minimum delay between rounds; omit for immediate continuation. */
    readonly intervalMs?: number;
    readonly now?: number;
}
/** Create a fresh, armed, active loop. */
export declare function createLoop(input: CreateLoopInput): LoopState;
/**
 * Replace the loop's objective in place, keeping its phase, arming, admitted
 * rounds and cadence. A round already queued by the driver keeps the text it
 * was queued with; every round queued afterwards restates the new objective.
 */
export declare function editLoopObjective(loop: LoopState, objective: string, now?: number): LoopState;
/** Bump the highest admitted round; no-op for non-increasing values. */
export declare function markRoundAdmitted(loop: LoopState, round: number, now?: number): LoopState;
/**
 * Arm or disarm the loop without changing its phase. Arming clears any recorded
 * pause; disarming without a reason keeps the previous one, so a later
 * unexplained disarm cannot erase why the loop first stopped.
 */
export declare function armLoop(loop: LoopState, armed: boolean, reason?: Omit<LoopPauseReason, 'at'>, now?: number): LoopState;
/** Record why an already-disarmed active loop stopped. No-op once armed. */
export declare function markPaused(loop: LoopState, reason: Omit<LoopPauseReason, 'at'>, now?: number): LoopState;
/** Mark the loop completed and disarm it. */
export declare function markCompleted(loop: LoopState, summary?: string, now?: number): LoopState;
/** Mark the loop blocked and disarm it. */
export declare function markBlocked(loop: LoopState, reason: LoopBlockedReason, now?: number): LoopState;
/** Mark the loop cancelled and disarm it. */
export declare function markCancelled(loop: LoopState, reason?: string, now?: number): LoopState;
/** Whether the loop may still accept continuation rounds. */
export declare function isRunning(loop: LoopState): boolean;
/**
 * Model-visible source carried by one admitted loop round prompt. Declared
 * here so both the driver (which produces it) and the tools (which
 * authenticate it) share one augmentation.
 */
export interface LoopMessageSource {
    readonly kind: 'loop';
    readonly loopId: string;
    /** Positive admitted continuation round. */
    readonly round: number;
}
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        loop: LoopMessageSource;
    }
}
/** Narrow an arbitrary source to a {@link LoopMessageSource}. */
export declare function isLoopSource(source: unknown): source is LoopMessageSource;
/**
 * Highest loop round admitted into the session log. The durable log is the
 * ground truth for round accounting; the checkpoint's `roundsStarted` is only
 * a hint for sessions whose log is unavailable.
 */
export declare function admittedRounds(agent: Agent, loopId: string): number;
/** Effective admitted-round count: durable log wins over the checkpoint hint. */
export declare function effectiveRounds(agent: Agent | undefined, loop: LoopState): number;
