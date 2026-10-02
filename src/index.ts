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
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { installAiInstallRoute } from './ai-install.js'
import { LoopStore } from './checkpoint.js'
import { installLoopCommand } from './command.js'
import { installLoopStatus } from './loop-status.js'
import { LoopController } from './controller.js'
import { installLoopDriver } from './driver.js'
import { installLoopDetection } from './loop-detect.js'
import { installDoSettings, plainSettings, type DoSettings } from './settings.js'
import { installSettingsRoute } from './settings-route.js'
import { registerLoopTools } from './tools.js'
import { installTuiCommand } from './tui.js'
import { installModelFallback } from './model-fallback.js'
import { installConfigCommand } from './config-command.js'

/** Cordis plugin name. */
export const name = 'loop'

/** Required services. */
export const inject = ['agents', 'tools', 'systemPrompt']

export { Config, DSH_DO_NS } from './settings.js'
export type { AutoContinueSettings, DoSettings, LoopDetectionSettings, ModelFallbackSettings } from './settings.js'

/** Derive the checkpoint root from configuration or the DSH home directory. */
export function resolveCheckpointDir(checkpointDir: string): string {
	if (checkpointDir !== '') return checkpointDir
	const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
	return join(home, 'loops')
}

/** Model-visible policy guidance rendered as a system-prompt section. */
const LOOP_GUIDANCE = `Use loop tools for a Claude Code-style autonomous loop: when a direct human request is a long-running objective that should keep iterating across turns, call loop_start with the objective and an optional round budget; the loop then auto-continues until the model calls loop_done, the budget is exhausted, or the loop is cancelled. A cancelled round disarms the loop until loop_start re-arms it. The human can drive the same loop with the /loop command. Prefer goal tools for goal-scoped continuation and one mechanism per task.`

/** Apply the plugin. */
export function apply(ctx: Context, rawConfig: DoSettings): void {
	// Read the plain values once for the wiring decisions below; the live config
	// object is handed to `installDoSettings` so later edits stay visible.
	const config = plainSettings(rawConfig)
	const storeFor = (settings: DoSettings): LoopStore | undefined =>
		settings.persist
			? new LoopStore(resolveCheckpointDir(settings.checkpointDir), { onError: (message) => ctx.logger.warn(message) })
			: undefined
	let storeDir = config.persist ? resolveCheckpointDir(config.checkpointDir) : undefined
	const controller = new LoopController(storeFor(config), ctx.logger)
	const restore = controller.restore().catch((error: unknown) => {
		ctx.logger.warn(`dsh-do: checkpoint restore failed; continuing in memory: ${String(error)}`)
	})
	// Settings are read live, so a committed `dsh-do:` section changes the loop
	// budget, the checkpoint target, and the detection policy without a restart.
	const settings = installDoSettings(ctx, rawConfig, (next) => {
		const wantedDir = next.persist ? resolveCheckpointDir(next.checkpointDir) : undefined
		if (wantedDir === storeDir) return
		storeDir = wantedDir
		controller.useStore(storeFor(next))
		ctx.logger.info(wantedDir === undefined ? 'dsh-do: loop checkpointing disabled' : `dsh-do: loop checkpoints now written to ${wantedDir}`)
	})
	ctx.effect(async function* () {
		await restore
		registerLoopTools(ctx, controller, { defaultMaxRounds: () => settings.read().defaultMaxRounds })
	}, 'dsh-do.tools()')
	ctx.effect(function* () {
		const driver = installLoopDriver(ctx, controller, restore, { autoContinue: () => settings.read().autoContinue })
		// Starting, replacing, or resuming a loop emits no agent lifecycle
		// transition (a slash command runs without a turn), so the driver must be
		// woken explicitly. Without this, `/loop <objective>` created an armed loop
		// whose first round never ran. Detach on teardown so a disposed driver is
		// never called by a later mutation.
		controller.setNotifier((loop) => {
			driver.nudge(loop.sessionId)
		})
		yield () => controller.setNotifier(undefined)
	}, 'dsh-do.driver()')
	installLoopCommand(ctx, controller, () => settings.read().defaultMaxRounds)
	// The status surface: a `loops` service plus a `loop` session projection,
	// registered the way the harness goal plugin registers `goal`. Without it an
	// active loop that stopped has no way to say so.
	installLoopStatus(ctx, controller)
	// The TUI profile owns a separate slash-command registry, so `/loop` has to be
	// registered there too; under web and headless the service never appears.
	installTuiCommand(ctx, controller, () => settings.read().defaultMaxRounds)
	installLoopDetection(ctx, {
		policy: () => settings.read().loopDetection,
		driverArmed: (agent) => {
			const loop = controller.get(agent.session.id)
			if (loop !== undefined && loop.phase === 'active' && loop.armed) return true
			// DSH's own goal driver pauses an armed goal when an admitted round is
			// cancelled, so the detector must not interrupt one either.
			const goals = ctx.get('goals') as { get(agent: Agent): { phase?: string; activation?: string } | undefined } | undefined
			if (goals === undefined) return false
			try {
				const goal = goals.get(agent)
				return goal !== undefined && goal.phase === 'active' && goal.activation === 'armed'
			} catch {
				return false
			}
		},
	})
	// Switch to the next configured model when the current one keeps failing
	// (after the provider's own retry policy has given up).
	installModelFallback(ctx, () => settings.read().modelFallback)
	// Settings are editable without a browser: `/do-config` in the TUI and the
	// harness command line, plus the `dsh-do:` section of settings.yaml.
	installConfigCommand(ctx)
	installAiInstallRoute(ctx)
	installSettingsRoute(ctx)
	ctx.systemPrompt.section({ name: 'tool:loop', order: 121, text: LOOP_GUIDANCE })
}
