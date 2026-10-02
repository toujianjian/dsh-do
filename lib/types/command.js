import { LOOP_ERROR } from './controller.js';
import { effectiveRounds, MAX_TIMER_DELAY_MS } from './loop.js';
/** Cadence used when `/loop` names no interval, matching Claude Code's default. */
export const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
/**
 * Claude Code derives its minimum cadence from cron's one-minute granularity
 * and rounds sub-minute intervals up. A driver delay has no such limit, but the
 * same floor keeps one `/loop` grammar meaning the same thing in both tools.
 */
export const MIN_INTERVAL_MS = 60 * 1000;
/** Longest accepted cadence, keeping the delay inside a 32-bit timer range. */
export const MAX_INTERVAL_MS = MAX_TIMER_DELAY_MS;
/** Usage text shown for an empty or unparsable invocation. */
export const LOOP_USAGE = `Usage: /loop [<interval>] [<objective>]

Run an objective as a dsh-DO autonomous loop, and keep it running.

Intervals: Ns, Nm, Nh, Nd (e.g. 30s, 5m, 2h, 1d); minimum 1 minute.
Without an interval the next round starts as soon as the model is idle.
A trailing "every <N><unit>" clause sets the interval too.

Control verbs:
  /loop                     show the current loop
  /loop pause               stop automatic continuation
  /loop resume              resume automatic continuation
  /loop edit <objective>    replace the objective, keeping the budget
  /loop done [summary]      mark the loop complete
  /loop cancel [reason]     cancel the loop
  /loop clear               cancel the loop (alias of cancel)`;
const UNIT_MS = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
};
/** Whole-number unit words accepted by the trailing `every` clause. */
const UNIT_WORDS = {
    second: 's',
    seconds: 's',
    minute: 'm',
    minutes: 'm',
    hour: 'h',
    hours: 'h',
    day: 'd',
    days: 'd',
};
/** Convert a parsed `<N><unit>` pair to a bounded millisecond cadence. */
function toIntervalMs(count, unit) {
    const scale = UNIT_MS[unit];
    if (scale === undefined || !Number.isSafeInteger(count) || count < 1)
        return undefined;
    const raw = count * scale;
    if (!Number.isSafeInteger(raw))
        return undefined;
    // Sub-minute cadences round up to the one-minute floor Claude Code uses.
    return Math.min(Math.max(raw, MIN_INTERVAL_MS), MAX_INTERVAL_MS);
}
/**
 * Extract a leading `N<unit>` interval token. Claude Code gives a leading token
 * priority over a trailing `every` clause, and only treats the first
 * whitespace-delimited token as an interval when it matches exactly.
 */
function leadingInterval(input) {
    const match = /^(\d+)\s*([smhd])(?=\s|$)/iu.exec(input);
    if (match === null)
        return { intervalMs: undefined, rest: input };
    const intervalMs = toIntervalMs(Number(match[1]), match[2].toLowerCase());
    if (intervalMs === undefined)
        return { intervalMs: undefined, rest: input };
    return { intervalMs, rest: input.slice(match[0].length).trim() };
}
/**
 * Extract a trailing `every <N><unit>` or `every <N> <unit-word>` clause. A
 * bare "every" followed by anything else is part of the objective, so
 * "check every PR" stays a valid objective.
 */
function trailingInterval(input) {
    const match = /(?:^|\s)every\s+(\d+)\s*([a-z]+)\s*$/iu.exec(input);
    if (match === null)
        return { intervalMs: undefined, rest: input };
    const word = match[2].toLowerCase();
    const unit = word.length === 1 ? word : UNIT_WORDS[word];
    if (unit === undefined)
        return { intervalMs: undefined, rest: input };
    const intervalMs = toIntervalMs(Number(match[1]), unit);
    if (intervalMs === undefined)
        return { intervalMs: undefined, rest: input };
    return { intervalMs, rest: input.slice(0, match.index).trim() };
}
/**
 * Parse one `/loop` invocation. Control verbs win over the objective grammar,
 * so an objective that is exactly a verb word is written as
 * `/loop edit <word>` instead of being read as that verb.
 *
 * @param rawInput - the text after the command name, whitespace included.
 * @returns the parsed invocation.
 */
export function parseLoopCommand(rawInput) {
    const input = rawInput.trim();
    if (input.length === 0)
        return { kind: 'show' };
    const verb = /^([A-Za-z]+)(?:\s+([\s\S]*))?$/u.exec(input);
    if (verb !== null) {
        const rest = (verb[2] ?? '').trim();
        switch (verb[1].toLowerCase()) {
            case 'status':
                if (rest.length === 0)
                    return { kind: 'show' };
                break;
            case 'pause':
                if (rest.length === 0)
                    return { kind: 'pause' };
                break;
            case 'resume':
                if (rest.length === 0)
                    return { kind: 'resume' };
                break;
            case 'edit':
                return rest.length === 0 ? { kind: 'invalid-edit' } : { kind: 'edit', objective: rest };
            case 'done':
                return rest.length === 0 ? { kind: 'done' } : { kind: 'done', summary: rest };
            case 'cancel':
                return rest.length === 0 ? { kind: 'cancel' } : { kind: 'cancel', reason: rest };
            case 'clear':
                if (rest.length === 0)
                    return { kind: 'cancel' };
                break;
            default:
                break;
        }
    }
    // A leading interval token wins over a trailing `every` clause.
    const leading = leadingInterval(input);
    if (leading.intervalMs !== undefined) {
        return leading.rest.length === 0
            ? { kind: 'show' }
            : { kind: 'start', objective: leading.rest, intervalMs: leading.intervalMs };
    }
    const trailing = trailingInterval(input);
    if (trailing.intervalMs !== undefined && trailing.rest.length > 0) {
        return { kind: 'start', objective: trailing.rest, intervalMs: trailing.intervalMs };
    }
    return { kind: 'start', objective: input, intervalMs: DEFAULT_INTERVAL_MS };
}
/** Human label for one durable loop phase. */
export function phaseLabel(loop) {
    switch (loop.phase) {
        case 'active':
            return loop.armed ? 'active' : 'paused';
        case 'completed':
            return 'complete';
        case 'blocked':
            return 'blocked';
        case 'cancelled':
            return 'cancelled';
    }
}
/** Render a cadence as the interval token `/loop` accepts back. */
export function renderInterval(intervalMs) {
    if (intervalMs % UNIT_MS.d === 0)
        return `${intervalMs / UNIT_MS.d}d`;
    if (intervalMs % UNIT_MS.h === 0)
        return `${intervalMs / UNIT_MS.h}h`;
    if (intervalMs % UNIT_MS.m === 0)
        return `${intervalMs / UNIT_MS.m}m`;
    return `${Math.round(intervalMs / 1000)}s`;
}
/** Commands that are meaningful from one exact live state. */
function commandHint(loop) {
    if (loop.phase !== 'active')
        return '/loop <objective>, /loop clear';
    return loop.armed
        ? '/loop pause, /loop edit <objective>, /loop done, /loop clear'
        : '/loop resume, /loop edit <objective>, /loop done, /loop clear';
}
/** Render one loop without exposing compare-and-set internals. */
export function renderLoop(title, loop, rounds) {
    const cadence = loop.intervalMs === undefined ? 'on idle' : `every ${renderInterval(loop.intervalMs)}`;
    const blocker = loop.phase === 'blocked' && loop.blockedReason !== undefined ? [`Blocker: ${loop.blockedReason.code}: ${loop.blockedReason.message}`] : [];
    return [
        title,
        `Status: ${phaseLabel(loop)}`,
        ...blocker,
        `Objective: ${loop.objective}`,
        `Rounds: ${rounds}/${loop.maxRounds}`,
        `Cadence: ${cadence}`,
        '',
        `Commands: ${commandHint(loop)}`,
    ].join('\n');
}
/** Closed-union backstop: unreachable while every member is handled above. */
function assertNever(value) {
    return { kind: 'error', text: `unhandled loop command: ${JSON.stringify(value)}` };
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
export function executeLoopCommand(controller, command, sessionId, defaultMaxRounds, rounds) {
    const current = controller.get(sessionId);
    try {
        switch (command.kind) {
            case 'show':
                return current === undefined
                    ? { kind: 'success', text: `No loop is currently set.\n${LOOP_USAGE}` }
                    : { kind: 'success', text: renderLoop('Loop', current, rounds(current)) };
            case 'invalid-edit':
                return { kind: 'error', text: `Loop editing requires a replacement objective.\n${LOOP_USAGE}` };
            case 'start': {
                if (current !== undefined && current.phase === 'active' && current.armed) {
                    return {
                        kind: 'error',
                        text: 'A loop is already active. Use /loop edit <objective> to change it, /loop pause to stop it, or /loop clear before starting a new one.',
                    };
                }
                if (current !== undefined && current.phase === 'active') {
                    // A paused loop is replaced, so say so: the user should know the
                    // previous objective and its spent rounds are gone. `/loop edit`
                    // is the path that keeps the budget.
                    const replaced = controller.start(sessionId, command.objective, defaultMaxRounds(), command.intervalMs);
                    return {
                        kind: 'success',
                        text: `${renderLoop('Loop restarted', replaced, rounds(replaced))}\n\nThe paused objective and its spent rounds were replaced. Use /loop edit <objective> to keep the budget instead.`,
                    };
                }
                const started = controller.start(sessionId, command.objective, defaultMaxRounds(), command.intervalMs);
                return { kind: 'success', text: renderLoop('Loop started', started, rounds(started)) };
            }
            case 'edit': {
                if (current === undefined) {
                    return { kind: 'error', text: `No loop is currently set; /loop edit requires one.\n${LOOP_USAGE}` };
                }
                if (current.phase !== 'active') {
                    const replaced = controller.start(sessionId, command.objective, defaultMaxRounds());
                    return { kind: 'success', text: renderLoop('Loop started', replaced, rounds(replaced)) };
                }
                const edited = controller.editObjective(sessionId, command.objective);
                return { kind: 'success', text: renderLoop('Loop updated', edited, rounds(edited)) };
            }
            case 'pause': {
                if (current === undefined)
                    return { kind: 'error', text: `No loop is currently set; /loop pause requires one.\n${LOOP_USAGE}` };
                return { kind: 'success', text: renderLoop('Loop paused', controller.arm(sessionId, false) ?? current, rounds(current)) };
            }
            case 'resume': {
                if (current === undefined)
                    return { kind: 'error', text: `No loop is currently set; /loop resume requires one.\n${LOOP_USAGE}` };
                return { kind: 'success', text: renderLoop('Loop resumed', controller.arm(sessionId, true) ?? current, rounds(current)) };
            }
            case 'done': {
                if (current === undefined || current.phase !== 'active') {
                    return { kind: 'error', text: `/loop done requires an active loop.\n${LOOP_USAGE}` };
                }
                return { kind: 'success', text: renderLoop('Loop complete', controller.complete(sessionId, command.summary), rounds(current)) };
            }
            case 'cancel': {
                if (current === undefined || current.phase !== 'active')
                    return { kind: 'success', text: 'No loop to clear.' };
                return { kind: 'success', text: renderLoop('Loop cancelled', controller.cancel(sessionId, command.reason), rounds(current)) };
            }
            default:
                return assertNever(command);
        }
    }
    catch (error) {
        // The domain rejects transitions its own phase checks already refused; the
        // live race between those two reads is the only way to reach this.
        const code = error instanceof Error ? error.code : undefined;
        if (code === LOOP_ERROR.NOT_ACTIVE || code === LOOP_ERROR.ALREADY_ACTIVE) {
            return { kind: 'error', text: 'The loop changed while this command ran; run /loop to see its current state.' };
        }
        throw error;
    }
}
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
export function installLoopCommand(ctx, controller, defaultMaxRounds) {
    ctx.inject(['commands'], (child) => {
        child.commands.register({
            name: 'loop',
            description: 'start, pace, pause, retarget, or end a dsh-DO autonomous loop',
            input: { hint: '[<interval>] [<objective>|pause|resume|edit <objective>|done|cancel]' },
            handler: (invocation) => executeLoopCommand(controller, parseLoopCommand(invocation.rawInput), invocation.agent.session.id, defaultMaxRounds, (loop) => effectiveRounds(invocation.agent, loop)),
        });
    });
}
//# sourceMappingURL=command.js.map