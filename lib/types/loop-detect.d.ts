/**
 * Model-loop detection and recovery.
 *
 * A model that repeats one tool call with identical arguments is not making
 * progress: the same observation is re-derived, the same request is re-sent,
 * and the session grows until its context is exhausted. This module counts
 * consecutive identical calls per agent and, at the configured threshold,
 * interrupts the turn, compacts the history, and re-sends the request so the
 * model continues from a smaller, loop-free state.
 *
 * It deliberately does NOT interrupt a session an autonomous driver already
 * owns. Both DSH's goal-round driver and this plugin's own loop driver pause
 * their mechanism when an admitted round is cancelled, so cancelling from here
 * would silently end the user's goal or loop. In that case the detector
 * delivers the same corrective text as non-interrupting context and leaves
 * continuation authority with the driver that owns it.
 *
 * @module dsh-do/loop-detect
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { LoopDetectionSettings } from './settings.js';
/** One agent's run of consecutive identical tool calls. */
export interface RepeatChain {
    /** `[name, canonicalArguments]`, so a different call resets the run. */
    readonly key: string;
    /** Length of the current run, at least 1. */
    readonly count: number;
}
/**
 * Deep key-sort of a parsed-JSON value so two argument objects that differ only
 * in property order canonicalize identically. Arguments reach this module as
 * the loop's parsed output, so JSON's value domain is the whole input domain.
 */
export declare function sortJsonValue(value: unknown): unknown;
/** Canonical string form of a call's arguments: deep key-sort, then stringify. */
export declare function canonicalizeArguments(value: unknown): string;
/** Advance one agent's run for a settled call. */
export declare function advanceRepeatChain(previous: RepeatChain | undefined, name: string, canonical: string): RepeatChain;
/** What the detector decided for one settled call. */
export type LoopVerdict = {
    readonly kind: 'continue';
}
/** Corrective context only: an autonomous driver owns continuation. */
 | {
    readonly kind: 'nudge';
    readonly count: number;
    readonly name: string;
}
/** Interrupt, compact, and re-send. */
 | {
    readonly kind: 'intervene';
    readonly count: number;
    readonly name: string;
};
/**
 * Decide what one settled call means for the agent's session.
 *
 * @param chain - the run after {@link advanceRepeatChain}.
 * @param policy - the live detection settings.
 * @param driverArmed - whether an autonomous driver owns this session's continuation.
 * @param interventions - interruptions already performed for this session.
 * @returns the verdict.
 */
export declare function decideLoopVerdict(chain: RepeatChain, policy: LoopDetectionSettings, driverArmed: boolean, interventions: number): LoopVerdict;
/** Head-truncate canonical arguments for quoting in a model-visible notice. */
export declare function previewArguments(canonical: string, cap?: number): string;
/** The corrective text delivered when the detector cannot interrupt. */
export declare function renderLoopNotice(name: string, count: number, canonical: string): ContentBlock[];
/** The instruction that re-sends the interrupted request over compacted history. */
export declare function renderRecoveryPrompt(name: string, count: number, compacted: boolean): ContentBlock[];
/** Options for {@link installLoopDetection}. */
export interface LoopDetectionOptions {
    /** Live detection settings. */
    policy: () => LoopDetectionSettings;
    /**
     * Whether an autonomous driver currently owns this session's continuation.
     * Required: interrupting such a session would pause the driver.
     */
    driverArmed: (agent: Agent) => boolean;
}
/**
 * Install model-loop detection and recovery.
 *
 * The listener rides a compaction-gated child context: the recovery this module
 * promises is stop-then-compact-then-resend, so a deployment without a
 * compaction service keeps its existing behavior instead of getting a partial
 * one.
 *
 * @param ctx - the plugin context.
 * @param options - live policy and the driver-ownership probe.
 */
export declare function installLoopDetection(ctx: Context, options: LoopDetectionOptions): void;
