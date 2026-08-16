import { boundContextSummary, createUserMessage, HarnessError } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { effectiveRounds, isLoopSource } from './loop.js';
import { renderLoopWrapupContext } from './prompt.js';
/** Execution-time authority checks for the model-facing loop tools. */
function reject(message, code = 'LOOP_TOOL_AUTHORITY_REQUIRED') {
    throw new HarnessError(message, code);
}
/** Locate the open turn enclosing a model tool call. */
function openTurn(agent) {
    const events = agent.session.events;
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const boundary = events[index];
        if (boundary?.type === 'turn/end') {
            reject('loop tools require an open model turn', 'LOOP_TOOL_DRIVER_REQUIRED');
        }
        if (boundary?.type === 'turn/start')
            return { events: events.slice(index + 1) };
    }
    return reject('loop tools require an open model turn', 'LOOP_TOOL_DRIVER_REQUIRED');
}
function loopToolExecution(ctx, exec) {
    const agent = exec.agent;
    if (agent === undefined)
        return reject('loop tools require a calling agent', 'LOOP_TOOL_AGENT_REQUIRED');
    if (ctx.agents.get(agent.id) !== agent || agent.status !== 'running' || ctx.agents.currentInitiator() !== agent) {
        return reject('loop tools require the exact live calling agent inside its active driver', 'LOOP_TOOL_DRIVER_REQUIRED');
    }
    return { agent, ...openTurn(agent) };
}
/**
 * Whether host-attested human input appears in the current root-agent turn.
 * An omitted source resolves to `user`, so non-human producers must supply
 * their own source rather than inheriting this authority.
 */
function hasDirectHumanInput(ctx, execution) {
    if (!ctx.agents.roots().includes(execution.agent))
        return false;
    return execution.events.some((event) => event.type === 'user/message' && event.data.source.kind === 'user');
}
/** Require authority originating in a human message accepted by a runtime root. */
function requireDirectHuman(ctx, execution) {
    if (!hasDirectHumanInput(ctx, execution)) {
        reject('this loop operation requires a direct human turn on a top-level agent');
    }
}
/** Whether this turn is the current loop's exact admitted round. */
function isMatchingLoopRound(execution, loop) {
    const rounds = effectiveRounds(execution.agent, loop);
    return execution.events.some((event) => event.type === 'user/message' &&
        isLoopSource(event.data.source) &&
        event.data.source.loopId === loop.id &&
        event.data.source.round === rounds);
}
/** Resolve completion authority from either direct human input or the exact loop round. */
function completionAuthority(ctx, execution, loop) {
    if (hasDirectHumanInput(ctx, execution))
        return { kind: 'direct-human' };
    if (isMatchingLoopRound(execution, loop))
        return { kind: 'loop-round' };
    return reject('loop_done and loop_cancel require a direct human turn or the current loop round');
}
/** Stable compact model result; `armed` is an observation, not replay state. */
function loopValue(agent, loop) {
    if (loop === undefined)
        return { loop: null };
    return {
        loop: {
            id: loop.id,
            objective: loop.objective,
            phase: loop.phase,
            armed: loop.armed,
            roundsStarted: effectiveRounds(agent, loop),
            maxRounds: loop.maxRounds,
            ...(loop.blockedReason === undefined
                ? {}
                : { blockedReason: { code: loop.blockedReason.code, message: loop.blockedReason.message } }),
            ...(loop.completedSummary === undefined ? {} : { completedSummary: loop.completedSummary }),
            ...(loop.cancelledReason === undefined ? {} : { cancelledReason: loop.cancelledReason }),
            startedAt: loop.startedAt,
            updatedAt: loop.updatedAt,
        },
    };
}
/** Reusable canonical output declaration for all four loop controls. */
const LOOP_OUTPUT = {
    schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
            loop: {
                oneOf: [
                    { type: 'null', required: true },
                    {
                        type: 'object',
                        additionalProperties: false,
                        required: true,
                        properties: {
                            id: { type: 'string', required: true },
                            objective: { type: 'string', required: true },
                            phase: { type: 'string', required: true, enum: ['active', 'completed', 'blocked', 'cancelled'] },
                            armed: { type: 'boolean', required: true },
                            roundsStarted: { type: 'integer', required: true },
                            maxRounds: { type: 'integer', required: true },
                            blockedReason: {
                                type: 'object',
                                additionalProperties: false,
                                properties: {
                                    code: { type: 'string', required: true },
                                    message: { type: 'string', required: true },
                                },
                            },
                            completedSummary: { type: 'string' },
                            cancelledReason: { type: 'string' },
                            startedAt: { type: 'number', required: true },
                            updatedAt: { type: 'number', required: true },
                        },
                    },
                ],
            },
        },
    },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
};
/** Generic, args-only pending presentation shared by the loop tools. */
function present(title, kind, rawInput) {
    return { card: 'generic', title, kind, ...(rawInput === undefined ? {} : { rawInput }) };
}
const START_DESCRIPTION = 'Start one Claude Code-style autonomous loop for the current session: the driver then auto-continues across turns, re-queueing the objective as <loop_round> prompts until the model calls loop_done, the round budget is exhausted, or the loop is cancelled. Use when a direct human request is a long-running objective that should keep iterating in this same session. If an active loop exists but is disarmed (e.g. after a cancelled round), this re-arms it with the stored objective. Execution rejects non-human and subagent authority.';
const STATUS_DESCRIPTION = 'Read the current loop for this session, including its exact id, objective, phase, rounds started, round budget, blocked reason when present, and whether it is armed to continue. Call this before loop_done or loop_cancel.';
const DONE_DESCRIPTION = 'Mark the current loop complete with an optional short summary. Allowed only from a direct human turn or the current loop round; otherwise rejected. When called from a loop round, the driver ends the autonomous run and asks the model to write the closing message.';
const CANCEL_DESCRIPTION = 'Mark the current loop cancelled with an optional concrete reason. Allowed only from a direct human turn or the current loop round; otherwise rejected. When called from a loop round, the driver ends the autonomous run and asks the model to write the closing message.';
/** Register the four loop tools. */
export function registerLoopTools(ctx, controller, config) {
    ctx.tools.register(defineTool({
        name: 'loop_start',
        description: START_DESCRIPTION,
        parameters: {
            objective: {
                type: 'string',
                required: true,
                description: 'The concrete completion objective to keep iterating toward across turns.',
            },
            max_rounds: {
                type: 'number',
                description: 'Optional positive safe-integer cap on automatic continuation rounds (defaults to the configured defaultMaxRounds).',
            },
        },
        output: LOOP_OUTPUT,
        execute(args, exec) {
            const execution = loopToolExecution(ctx, exec);
            requireDirectHuman(ctx, execution);
            const maxRounds = args.max_rounds === undefined ? config.defaultMaxRounds : args.max_rounds;
            if (!Number.isSafeInteger(maxRounds) || maxRounds < 1) {
                throw new HarnessError('max_rounds must be a positive safe integer', 'LOOP_TOOL_INVALID_ROUNDS');
            }
            const loop = controller.start(execution.agent.session.id, args.objective, maxRounds);
            return Promise.resolve(loopValue(execution.agent, loop));
        },
        presentCall: (args) => present('Start loop', 'other', args.objective),
    }));
    ctx.tools.register(defineTool({
        name: 'loop_status',
        description: STATUS_DESCRIPTION,
        parameters: {},
        output: LOOP_OUTPUT,
        execute(_args, exec) {
            const execution = loopToolExecution(ctx, exec);
            return Promise.resolve(loopValue(execution.agent, controller.get(execution.agent.session.id)));
        },
        presentCall: () => present('Read loop status', 'read'),
    }));
    ctx.tools.register(defineTool({
        name: 'loop_done',
        description: DONE_DESCRIPTION,
        parameters: {
            summary: {
                type: 'string',
                description: 'Optional one-line summary of what was achieved.',
            },
        },
        output: LOOP_OUTPUT,
        execute(args, exec) {
            const execution = loopToolExecution(ctx, exec);
            const agent = execution.agent;
            const loop = controller.get(agent.session.id);
            if (loop === undefined || loop.phase !== 'active') {
                return Promise.reject(new HarnessError('loop_done requires an active loop for this session', 'LOOP_NOT_ACTIVE'));
            }
            completionAuthority(ctx, execution, loop);
            if (isMatchingLoopRound(execution, loop)) {
                exec.deferContext(createUserMessage({
                    content: renderLoopWrapupContext(loop.objective, {
                        kind: 'completed',
                        ...(args.summary === undefined ? {} : { summary: args.summary }),
                    }),
                    source: {
                        kind: 'plugin',
                        plugin: 'dsh-do',
                        form: 'notice',
                        summary: boundContextSummary(`loop_done: ${loop.objective}`),
                    },
                }));
            }
            return Promise.resolve(loopValue(agent, controller.complete(agent.session.id, args.summary)));
        },
        presentCall: (args) => present('Complete loop', 'other', args.summary),
    }));
    ctx.tools.register(defineTool({
        name: 'loop_cancel',
        description: CANCEL_DESCRIPTION,
        parameters: {
            reason: {
                type: 'string',
                description: 'Optional concrete reason the loop cannot continue.',
            },
        },
        output: LOOP_OUTPUT,
        execute(args, exec) {
            const execution = loopToolExecution(ctx, exec);
            const agent = execution.agent;
            const loop = controller.get(agent.session.id);
            if (loop === undefined || loop.phase !== 'active') {
                return Promise.reject(new HarnessError('loop_cancel requires an active loop for this session', 'LOOP_NOT_ACTIVE'));
            }
            completionAuthority(ctx, execution, loop);
            if (isMatchingLoopRound(execution, loop)) {
                exec.deferContext(createUserMessage({
                    content: renderLoopWrapupContext(loop.objective, {
                        kind: 'cancelled',
                        ...(args.reason === undefined ? {} : { reason: args.reason }),
                    }),
                    source: {
                        kind: 'plugin',
                        plugin: 'dsh-do',
                        form: 'notice',
                        summary: boundContextSummary(`loop_cancel: ${loop.objective}`),
                    },
                }));
            }
            return Promise.resolve(loopValue(agent, controller.cancel(agent.session.id, args.reason)));
        },
        presentCall: (args) => present('Cancel loop', 'other', args.reason),
    }));
}
//# sourceMappingURL=tools.js.map