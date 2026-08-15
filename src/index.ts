/**
 * dsh-loop: a Claude Code-style autonomous loop for DeepSeek Harness.
 *
 * Registers four model-facing tools (`loop_start`, `loop_status`,
 * `loop_done`, `loop_cancel`) and a round-continuation driver. After an armed
 * active loop's agent goes idle, the driver queues the next `<loop_round>`
 * followup until the model calls `loop_done`, the round budget is exhausted
 * (blocked, `round-limit`), or the loop is cancelled. Loop state is
 * checkpointed atomically under a configurable directory and restored on
 * startup, so an interrupted run resumes when its session comes back live.
 *
 * @module dsh-loop
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LoopStore } from './checkpoint.js'
import { LoopController } from './controller.js'
import { installLoopDriver } from './driver.js'
import { registerLoopTools } from './tools.js'

/** Cordis plugin name. */
export const name = 'loop'

/** Required services. */
export const inject = ['agents', 'tools', 'systemPrompt']

export interface Config {
	/** Default cap on automatic continuation rounds when `max_rounds` is omitted. */
	defaultMaxRounds: number
	/** Directory for durable loop checkpoints; empty derives from DSH_HOME. */
	checkpointDir: string
	/** Set false to keep loop state in memory only (no checkpoint files). */
	persist: boolean
}

/** Config schema. */
export const Config = z.object({
	defaultMaxRounds: z.number().step(1).min(1).default(20),
	checkpointDir: z.string().default(''),
	persist: z.boolean().default(true),
})

/** Derive the checkpoint root from configuration or the DSH home directory. */
export function resolveCheckpointDir(checkpointDir: string): string {
	if (checkpointDir !== '') return checkpointDir
	const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
	return join(home, 'loops')
}

/** Model-visible policy guidance rendered as a system-prompt section. */
const LOOP_GUIDANCE = `Use loop tools for a Claude Code-style autonomous loop: when a direct human request is a long-running objective that should keep iterating across turns, call loop_start with the objective and an optional round budget; the loop then auto-continues until the model calls loop_done, the budget is exhausted, or the loop is cancelled. A cancelled round disarms the loop until loop_start re-arms it. Prefer goal tools for goal-scoped continuation and one mechanism per task.`

/** Apply the plugin. */
export function apply(ctx: Context, config: Config): void {
	const controller = new LoopController(
		config.persist ? new LoopStore(resolveCheckpointDir(config.checkpointDir), { onError: (message) => ctx.logger.warn(message) }) : undefined,
		ctx.logger,
	)
	const restore = controller.restore().catch((error: unknown) => {
		ctx.logger.warn(`dsh-loop: checkpoint restore failed; continuing in memory: ${String(error)}`)
	})
	ctx.effect(async function* () {
		await restore
		registerLoopTools(ctx, controller, { defaultMaxRounds: config.defaultMaxRounds })
	}, 'dsh-loop.tools()')
	ctx.effect(function* () {
		installLoopDriver(ctx, controller, restore)
	}, 'dsh-loop.driver()')
	ctx.systemPrompt.section({ name: 'tool:loop', order: 121, text: LOOP_GUIDANCE })
}
