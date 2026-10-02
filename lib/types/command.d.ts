/**
 * The human-facing `/loop` command: a user-invocable slash command over the
 * same persisted loop domain the model tools drive.
 *
 * Its grammar is Claude Code's `/loop [interval] <prompt>` — a leading
 * `Ns`/`Nm`/`Nh`/`Nd` token or a trailing `every <N><unit>` clause sets the
 * cadence, and the remainder is the objective — extended with the control
 * verbs DSH's `/goal` exposes, so a human can start, inspect, pace, pause,
 * resume, retarget, and end a loop without asking the model to do it.
 *
 * @module dsh-do/command
 */
import type { Context } from '@deepseek-ai/cordis';
import { type LoopController } from './controller.js';
import { type LoopState } from './loop.js';
/** Cadence used when `/loop` names no interval, matching Claude Code's default. */
export declare const DEFAULT_INTERVAL_MS: number;
/**
 * Claude Code derives its minimum cadence from cron's one-minute granularity
 * and rounds sub-minute intervals up. A driver delay has no such limit, but the
 * same floor keeps one `/loop` grammar meaning the same thing in both tools.
 */
export declare const MIN_INTERVAL_MS: number;
/** Longest accepted cadence, keeping the delay inside a 32-bit timer range. */
export declare const MAX_INTERVAL_MS = 2147483647;
/** Usage text shown for an empty or unparsable invocation. */
export declare const LOOP_USAGE = "Usage: /loop [<interval>] [<objective>]\n\nRun an objective as a dsh-DO autonomous loop, and keep it running.\n\nIntervals: Ns, Nm, Nh, Nd (e.g. 30s, 5m, 2h, 1d); minimum 1 minute.\nWithout an interval the next round starts as soon as the model is idle.\nA trailing \"every <N><unit>\" clause sets the interval too.\n\nControl verbs:\n  /loop                     show the current loop\n  /loop pause               stop automatic continuation\n  /loop resume              resume automatic continuation\n  /loop edit <objective>    replace the objective, keeping the budget\n  /loop done [summary]      mark the loop complete\n  /loop cancel [reason]     cancel the loop\n  /loop clear               cancel the loop (alias of cancel)";
/** One parsed `/loop` invocation. */
export type LoopCommand = {
    readonly kind: 'show';
} | {
    readonly kind: 'start';
    readonly objective: string;
    readonly intervalMs: number;
} | {
    readonly kind: 'pause';
} | {
    readonly kind: 'resume';
} | {
    readonly kind: 'edit';
    readonly objective: string;
} | {
    readonly kind: 'done';
    readonly summary?: string;
} | {
    readonly kind: 'cancel';
    readonly reason?: string;
} | {
    readonly kind: 'invalid-edit';
};
/**
 * Parse one `/loop` invocation. Control verbs win over the objective grammar,
 * so an objective that is exactly a verb word is written as
 * `/loop edit <word>` instead of being read as that verb.
 *
 * @param rawInput - the text after the command name, whitespace included.
 * @returns the parsed invocation.
 */
export declare function parseLoopCommand(rawInput: string): LoopCommand;
/** Human label for one durable loop phase. */
export declare function phaseLabel(loop: LoopState): string;
/** Render a cadence as the interval token `/loop` accepts back. */
export declare function renderInterval(intervalMs: number): string;
/** Render one loop without exposing compare-and-set internals. */
export declare function renderLoop(title: string, loop: LoopState, rounds: number): string;
/** One direct UI outcome. */
export interface CommandOutcome {
    readonly kind: 'success' | 'error';
    readonly text: string;
}
/**
 * Execute one parsed `/loop` invocation against the loop domain.
 *
 * @param controller - the loop registry.
 * @param command - the parsed invocation.
 * @param sessionId - the calling agent's session.
 * @param defaultMaxRounds - live settings reader for a newly started loop's budget.
 * @param rounds - effective admitted rounds for the current loop.
 * @returns the outcome the dispatching UI renders.
 */
export declare function executeLoopCommand(controller: LoopController, command: LoopCommand, sessionId: string, defaultMaxRounds: () => number, rounds: (loop: LoopState) => number): CommandOutcome;
/**
 * Register `/loop` for every composed command adapter.
 *
 * The registration rides a command-gated child context, so a profile without a
 * command registry never registers it instead of failing the whole plugin.
 *
 * @param ctx - the plugin context.
 * @param controller - the loop registry the command drives.
 * @param defaultMaxRounds - live settings reader for a new loop's budget.
 */
export declare function installLoopCommand(ctx: Context, controller: LoopController, defaultMaxRounds: () => number): void;
