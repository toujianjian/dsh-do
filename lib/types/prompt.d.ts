/**
 * Model-visible prompt renderers for loop rounds and closing wrapups.
 * Pure functions: identical inputs produce identical blocks.
 *
 * @module dsh-do/prompt
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
/**
 * Render the complete round instruction retained in session history.
 * @param objective - the loop's concrete completion objective.
 * @param round - the next positive round number.
 * @param maxRounds - the loop's round budget.
 * @returns a fresh one-block prompt for `Agent.followup()`.
 */
export declare function renderLoopRoundPrompt(objective: string, round: number, maxRounds: number): ContentBlock[];
/** One autonomous ending that concludes a loop. */
export type LoopEnding = {
    kind: 'completed';
    summary?: string;
} | {
    kind: 'cancelled';
    reason?: string;
};
/**
 * Render the notice written into the conversation when the driver stops
 * continuing an active loop.
 *
 * A stopped loop used to be indistinguishable from a working one: the round
 * simply stopped arriving and nothing said why. This notice closes that gap by
 * reporting the cause where the rounds were visible, and restating how to
 * resume, so the human does not have to inspect a checkpoint file to find out.
 * @param reason - the recorded stop cause.
 * @param loopId - the stopped loop's identity, echoed for `/loop` follow-ups.
 * @returns a fresh one-block notice for `Agent.followup()`.
 */
export declare function renderLoopPauseNotice(reason: {
    readonly code: string;
    readonly message: string;
}, loopId?: string): ContentBlock[];
/**
 * Render the closing-message instruction injected after an autonomous loop
 * round reports `loop_done` or `loop_cancel`, so the model still addresses
 * the user once before the turn ends.
 * @param objective - the terminal loop's objective, echoed for grounding.
 * @param ending - the validated terminal report.
 * @returns a fresh one-block context for `ToolRunContext.deferContext()`.
 */
export declare function renderLoopWrapupContext(objective: string, ending: LoopEnding): ContentBlock[];
