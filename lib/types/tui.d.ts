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
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { LoopController } from './controller.js';
/** The Cordis service name the TUI publishes its slash-command registry under. */
export declare const TUI_COMMANDS_SERVICE = "tui.commands";
/** The command name; it collides with no TUI builtin, so prefix resolution stays unambiguous. */
export declare const TUI_LOOP_COMMAND_NAME = "loop";
/** Shown in the TUI's inline `/` hint line. */
export declare const TUI_LOOP_ARGS_HINT = "[<interval>] [<objective>|pause|resume|edit <objective>|done|cancel]";
/** Description shown by the TUI command list. */
export declare const TUI_LOOP_DESCRIPTION = "\u81EA\u4E3B\u5FAA\u73AF\uFF1A\u67E5\u770B/\u542F\u52A8/\u6682\u505C/\u6062\u590D/\u6539\u76EE\u6807/\u5B8C\u6210/\u53D6\u6D88\uFF08dsh-DO\uFF09";
/** What the TUI passes to a command's `run`. */
export interface TuiCommandRunArgs {
    /** Everything after the command token, trimmed. */
    readonly text: string;
    /** Writes one line into the terminal scrollback. */
    readonly echo: (line: string) => void;
    /** The live session id, or `null` when no session is attached. */
    readonly sessionId: string | null;
}
/** A command definition accepted by the TUI's registry. */
export interface TuiSlashCommand {
    readonly name: string;
    readonly description: string;
    readonly argsHint?: string;
    readonly run: (args: TuiCommandRunArgs) => void | Promise<void>;
}
/**
 * The slice of the TUI registry this module uses.
 *
 * The TUI's `register` returns nothing and same-name registration overwrites, so
 * teardown is an explicit `unregister`.
 */
export interface TuiCommandRegistry {
    register(command: TuiSlashCommand): void;
    unregister(name: string): void;
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
export declare function isTuiCommandRegistry(value: unknown): value is TuiCommandRegistry;
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
export declare function buildTuiLoopCommand(deps: {
    readonly controller: LoopController;
    readonly defaultMaxRounds: () => number;
    readonly findAgent: (sessionId: string) => Agent | undefined;
}): TuiSlashCommand;
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
export declare function installTuiCommand(ctx: Context, controller: LoopController, defaultMaxRounds: () => number): void;
