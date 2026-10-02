/**
 * dsh-do: a Claude Code-style autonomous loop for DeepSeek Harness.
 *
 * Registers four model-facing tools (`loop_start`, `loop_status`,
 * `loop_done`, `loop_cancel`), a round-continuation driver, the `/loop`
 * human command, and a `dsh-do` settings namespace that makes the loop budget,
 * checkpoint policy and model-loop detection editable at runtime. After an
 * armed active loop's agent goes idle, the driver queues the next
 * `<loop_round>` followup until the model calls `loop_done`, the round budget
 * is exhausted (blocked, `round-limit`), or the loop is cancelled. Loop state
 * is checkpointed atomically under a configurable directory and restored on
 * startup, so an interrupted run resumes when its session comes back live.
 *
 * @module dsh-do
 */
import type { Context } from '@deepseek-ai/cordis';
import { type DoSettings } from './settings.js';
/** Cordis plugin name. */
export declare const name = "loop";
/** Required services. */
export declare const inject: string[];
export { Config, DSH_DO_NS } from './settings.js';
export type { AutoContinueSettings, DoSettings, LoopDetectionSettings, ModelFallbackSettings } from './settings.js';
/** Derive the checkpoint root from configuration or the DSH home directory. */
export declare function resolveCheckpointDir(checkpointDir: string): string;
/** Apply the plugin. */
export declare function apply(ctx: Context, config: DoSettings): void;
