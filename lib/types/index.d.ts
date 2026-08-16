/**
 * dsh-do: a Claude Code-style autonomous loop for DeepSeek Harness.
 *
 * Registers four model-facing tools (`loop_start`, `loop_status`,
 * `loop_done`, `loop_cancel`) and a round-continuation driver. After an armed
 * active loop's agent goes idle, the driver queues the next `<loop_round>`
 * followup until the model calls `loop_done`, the round budget is exhausted
 * (blocked, `round-limit`), or the loop is cancelled. Loop state is
 * checkpointed atomically under a configurable directory and restored on
 * startup, so an interrupted run resumes when its session comes back live.
 *
 * @module dsh-do
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** Cordis plugin name. */
export declare const name = "loop";
/** Required services. */
export declare const inject: string[];
export interface Config {
    /** Default cap on automatic continuation rounds when `max_rounds` is omitted. */
    defaultMaxRounds: number;
    /** Directory for durable loop checkpoints; empty derives from DSH_HOME. */
    checkpointDir: string;
    /** Set false to keep loop state in memory only (no checkpoint files). */
    persist: boolean;
}
/** Config schema. */
export declare const Config: z<Schemastery.ObjectS<{
    defaultMaxRounds: z<number, number>;
    checkpointDir: z<string, string>;
    persist: z<boolean, boolean>;
}>, Schemastery.ObjectT<{
    defaultMaxRounds: z<number, number>;
    checkpointDir: z<string, string>;
    persist: z<boolean, boolean>;
}>>;
/** Derive the checkpoint root from configuration or the DSH home directory. */
export declare function resolveCheckpointDir(checkpointDir: string): string;
/** Apply the plugin. */
export declare function apply(ctx: Context, config: Config): void;
