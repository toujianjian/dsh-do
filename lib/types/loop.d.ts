import type { Agent } from '@deepseek-ai/dsh-agent';
/** Stable identity of one loop. */
export type LoopId = string & {
    readonly __loopId: unique symbol;
};
/** Mint a loop identity from its string form. */
export declare function LoopId(value: string): LoopId;
/** Lifecycle phase of a loop. */
export type LoopPhase = 'active' | 'completed' | 'blocked' | 'cancelled';
/** Structured reason a loop was blocked. */
export interface LoopBlockedReason {
    readonly code: string;
    readonly message: string;
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
    readonly phase: LoopPhase;
    /** Whether the driver may queue the next round automatically. */
    readonly armed: boolean;
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
    readonly now?: number;
}
/** Create a fresh, armed, active loop. */
export declare function createLoop(input: CreateLoopInput): LoopState;
/** Bump the highest admitted round; no-op for non-increasing values. */
export declare function markRoundAdmitted(loop: LoopState, round: number, now?: number): LoopState;
/** Arm or disarm the loop without changing its phase. */
export declare function armLoop(loop: LoopState, armed: boolean, now?: number): LoopState;
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
