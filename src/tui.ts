/**
 * The TUI half of dsh-DO.
 *
 * `@huiliyi37/dsh-tianshu-tui` (the `dsh-tui` profile's UI layer) does NOT read
 * the harness-wide `commands` service that `/loop` registers into. It owns a
 * separate slash-command registry and documents one extension point for outside
 * plugins:
 *
 *     ctx.get('tui.commands')?.register(...)
 *
 * Without this module `/loop` would be invisible in a TUI session while the
 * model-facing `loop_*` tools kept working, which is exactly the gap this file
 * closes. The registry is provided by the TUI app at construction, so the
 * registration waits for the service instead of requiring it: under the web or
 * headless profiles the service never appears and this module does nothing.
 *
 * Both halves drive the same `LoopController`, so a loop started from the TUI
 * slash line is the same loop the tools and the driver operate on.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { LoopController } from './controller.js'
import { executeLoopCommand, parseLoopCommand } from './command.js'
import { effectiveRounds } from './loop.js'

/** The Cordis service name the TUI publishes its slash-command registry under. */
export const TUI_COMMANDS_SERVICE = 'tui.commands'

/** The command name; it collides with no TUI builtin, so prefix resolution stays unambiguous. */
export const TUI_LOOP_COMMAND_NAME = 'loop'

/** Shown in the TUI's inline `/` hint line. */
export const TUI_LOOP_ARGS_HINT = '[<interval>] [<objective>|pause|resume|edit <objective>|done|cancel]'

/** Description shown by the TUI command list. */
export const TUI_LOOP_DESCRIPTION = '自主循环：查看/启动/暂停/恢复/改目标/完成/取消（dsh-DO）'

/** What the TUI passes to a command's `run`. */
export interface TuiCommandRunArgs {
	/** Everything after the command token, trimmed. */
	readonly text: string
	/** Writes one line into the terminal scrollback. */
	readonly echo: (line: string) => void
	/** The live session id, or `null` when no session is attached. */
	readonly sessionId: string | null
}

/** A command definition accepted by the TUI's registry. */
export interface TuiSlashCommand {
	readonly name: string
	readonly description: string
	readonly argsHint?: string
	readonly run: (args: TuiCommandRunArgs) => void | Promise<void>
}

/**
 * The slice of the TUI registry this module uses.
 *
 * The TUI's `register` returns nothing and same-name registration overwrites, so
 * teardown is an explicit `unregister`.
 */
export interface TuiCommandRegistry {
	register(command: TuiSlashCommand): void
	unregister(name: string): void
}

/**
 * Narrow an unknown service value to a usable TUI registry.
 *
 * The name `tui.commands` is not part of the harness's declared service surface,
 * so the value is whatever a third-party TUI plugin happened to publish; a shape
 * check keeps a lookalike service from breaking the plugin.
 *
 * @param value - the value read from the service store.
 * @returns whether it can be registered into.
 */
export function isTuiCommandRegistry(value: unknown): value is TuiCommandRegistry {
	if (value === null || typeof value !== 'object') return false
	const candidate = value as Partial<TuiCommandRegistry>
	return typeof candidate.register === 'function' && typeof candidate.unregister === 'function'
}

/**
 * Build the `/loop` command the TUI registers.
 *
 * Kept separate from installation so the handler is testable without a Cordis
 * runtime.
 *
 * @param deps - the shared controller, the live settings reader, and the agent
 *   lookup used to report the effective round count.
 * @returns the command definition.
 */
export function buildTuiLoopCommand(deps: {
	readonly controller: LoopController
	readonly defaultMaxRounds: () => number
	readonly findAgent: (sessionId: string) => Agent | undefined
}): TuiSlashCommand {
	return {
		name: TUI_LOOP_COMMAND_NAME,
		description: TUI_LOOP_DESCRIPTION,
		argsHint: TUI_LOOP_ARGS_HINT,
		run: ({ text, echo, sessionId }) => {
			// The TUI runs commands from the input line even before a session is
			// attached; a loop is per-session, so say so instead of throwing.
			if (sessionId === null) {
				echo('⚠ 当前无会话，无法操作循环')
				return
			}
			const agent = deps.findAgent(sessionId)
			const outcome = executeLoopCommand(
				deps.controller,
				parseLoopCommand(text),
				sessionId,
				deps.defaultMaxRounds,
				(loop) => effectiveRounds(agent, loop),
			)
			// Errors are prefixed so a refusal reads as a refusal in the terminal,
			// matching the TUI's own builtin commands.
			echo(outcome.kind === 'error' ? `⚠ ${outcome.text}` : outcome.text)
		},
	}
}

/**
 * Register `/loop` into the TUI's slash-command registry once it exists.
 *
 * `ctx.inject` waits for the service, so this is a no-op under the web and
 * headless profiles (which never publish `tui.commands`) and activates whenever
 * a TUI profile is composed. The registration is torn down with the fiber.
 *
 * @param ctx - the plugin context.
 * @param controller - the shared loop controller.
 * @param defaultMaxRounds - live reader for the configured round budget.
 */
export function installTuiCommand(
	ctx: Context,
	controller: LoopController,
	defaultMaxRounds: () => number,
): void {
	ctx.inject([TUI_COMMANDS_SERVICE], (tuiCtx) => {
		const registry = tuiCtx.get(TUI_COMMANDS_SERVICE)
		if (!isTuiCommandRegistry(registry)) {
			ctx.logger.warn(`dsh-do: service "${TUI_COMMANDS_SERVICE}" is not a slash-command registry; /loop is unavailable in this TUI`)
			return
		}
		registry.register(buildTuiLoopCommand({
			controller,
			defaultMaxRounds,
			// The TUI brands its ids with `SessionId(...)`, so the value it passes
			// back is already the branded type at runtime.
			findAgent: (sessionId) => ctx.agents.get(SessionId(sessionId)),
		}))
		tuiCtx.effect(() => () => registry.unregister(TUI_LOOP_COMMAND_NAME))
	})
}
