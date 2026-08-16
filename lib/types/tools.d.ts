/**
 * Model-facing `loop_start`, `loop_status`, `loop_done`, and `loop_cancel`
 * tools over the persisted same-session loop domain.
 *
 * @module dsh-do/tools
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { LoopController } from './controller.js';
import { type LoopState } from './loop.js';
/** Authenticated loop tool execution: the exact live calling agent and its current turn window. */
export interface LoopToolExecution {
    readonly agent: Agent;
    readonly events: readonly SessionEvent[];
}
/** Compact canonical view of one loop, matching the output schema. */
export interface LoopView {
    loop: {
        id: string;
        objective: string;
        phase: LoopState['phase'];
        armed: boolean;
        roundsStarted: number;
        maxRounds: number;
        blockedReason?: {
            code: string;
            message: string;
        };
        completedSummary?: string;
        cancelledReason?: string;
        startedAt: number;
        updatedAt: number;
    } | null;
}
/** Register the four loop tools. */
export declare function registerLoopTools(ctx: Context, controller: LoopController, config: {
    defaultMaxRounds: number;
}): void;
