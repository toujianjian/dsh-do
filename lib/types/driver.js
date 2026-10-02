/**
 * Round-continuation driver: after an armed active loop's agent goes idle,
 * queue the next `<loop_round>` followup until the loop completes, blocks at
 * its budget, or is cancelled. Mirrors the harness goal-round driver's
 * race fences: competing-prompt detection, inbox claim/discard tracking, and
 * the `agent/pre-step` reservation waterfall that rejects stale or foreign
 * round prompts without disturbing other claimed messages.
 *
 * @module dsh-do/driver
 */
import { isDeepStrictEqual } from 'node:util';
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { effectiveRounds, isLoopSource, MAX_TIMER_DELAY_MS } from './loop.js';
import { renderLoopPauseNotice, renderLoopRoundPrompt } from './prompt.js';
import { decideAutoContinue, describeAutoContinueStop, renderAutoContinuePrompt } from './auto-continue.js';
/** Source stamped on the driver's own notices, matching the detector's. */
const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'dsh-do' };
function renderThrown(value) {
    return value instanceof Error ? value.message : String(value);
}
/** Whether the queued record matches one exact reservation. */
function sameQueued(content, source, attempt) {
    return source.loopId === attempt.loopId && source.round === attempt.round && isDeepStrictEqual(content, attempt.content);
}
/**
 * Install the round-continuation driver for one plugin context. The driver
 * effect owns its teardown (joins every in-flight run, disarms every loop).
 * When `restore` is supplied, listeners are installed only after it settles,
 * and agents already idle at that point are nudged so a restored armed loop
 * resumes without waiting for the next status transition.
 * @returns the external wakeup handle the controller's change sink drives.
 */
export function installLoopDriver(ctx, controller, restore, options = {}) {
    const states = new Map();
    function stateFor(agent) {
        let state = states.get(agent);
        if (state === undefined) {
            state = {
                agent,
                attempt: undefined,
                competingQueued: false,
                requested: false,
                run: undefined,
                stopping: false,
                lastRoundAt: undefined,
                paceTimer: undefined,
                continueStreak: 0,
            };
            states.set(agent, state);
        }
        return state;
    }
    /** Read only when the exact Agent remains live. */
    function loopOf(state) {
        if (ctx.agents.get(state.agent.id) !== state.agent)
            return undefined;
        return controller.get(state.agent.session.id);
    }
    /** Whether this exact lifecycle is quiescent with no competing prompt. */
    function readyToDrive(state) {
        return (ctx.fiber.state === 2 &&
            !state.stopping &&
            ctx.agents.get(state.agent.id) === state.agent &&
            state.agent.status === 'idle' &&
            // Insert notifications may predate installation/restore, and idle clears
            // the transient competing flag. Never overtake pending turn input.
            state.agent.inbox.nextTurn.length === 0 &&
            !state.competingQueued);
    }
    /** Cancel a pending interval wakeup. Safe to call when none is armed. */
    function clearPace(state) {
        if (state.paceTimer === undefined)
            return;
        clearTimeout(state.paceTimer);
        state.paceTimer = undefined;
    }
    /**
     * Remove automatic authority while preserving the durable phase, recording
     * why so an active-but-stopped loop can explain itself to a human instead of
     * simply going quiet.
     *
     * The recorded cause alone would still be silent — a checkpoint field nobody
     * reads mid-session. Announcing the stop as a conversation notice is what
     * makes it visible in the same place the round ran, in every client.
     */
    function disarm(state, reason) {
        clearPace(state);
        const loop = loopOf(state);
        if (loop === undefined || !loop.armed)
            return;
        const stopped = controller.arm(state.agent.session.id, false, reason);
        if (stopped === undefined)
            return;
        try {
            // Queued as a followup so it lands in the conversation the human is
            // already reading. A failing announcement must never undo the stop.
            state.agent.followup(createUserMessage({
                content: renderLoopPauseNotice(reason),
                source: { ...PLUGIN_SOURCE, form: 'notice', summary: boundContextSummary(`dsh-do loop paused: ${reason.code}`) },
            }));
        }
        catch (error) {
            ctx.logger.warn(`dsh-do: could not announce the pause for agent "${state.agent.id}": ${renderThrown(error)}`);
        }
    }
    /** Preserve claimed step context when the driver drops only its own round. */
    function restoreOtherClaimed(agent, messages, messageId) {
        const retained = messages.filter((message) => message.id !== messageId && !isLoopSource(message.source));
        for (const message of retained.toReversed()) {
            if (agent.inbox.nextStep.some((candidate) => candidate.id === message.id) ||
                agent.inbox.nextTurn.some((candidate) => candidate.id === message.id)) {
                continue;
            }
            agent.inbox.prepend('next-step', message);
        }
    }
    /** Fail closed unless the queued prompt still owns the exact live revision. */
    function validReservation(state, content, source) {
        const attempt = state.attempt;
        const loop = loopOf(state);
        return (ctx.fiber.state === 2 &&
            !state.stopping &&
            attempt !== undefined &&
            attempt.phase === 'claimed' &&
            !state.competingQueued &&
            !attempt.stale &&
            sameQueued(content, source, attempt) &&
            loop !== undefined &&
            loop.id === source.loopId &&
            loop.phase === 'active' &&
            loop.armed &&
            source.round === effectiveRounds(state.agent, loop) + 1);
    }
    /** Process admitted work at quiescence, then reserve at most one next round. */
    async function drive(state) {
        const { agent } = state;
        if (!readyToDrive(state))
            return;
        if (state.attempt !== undefined) {
            state.attempt = undefined;
            state.requested = true;
            return;
        }
        const loop = loopOf(state);
        if (loop === undefined || loop.phase !== 'active' || !loop.armed)
            return;
        const rounds = effectiveRounds(agent, loop);
        if (rounds >= loop.maxRounds) {
            try {
                controller.block(agent.session.id, 'round-limit', `Loop reached its configured limit of ${loop.maxRounds} rounds.`);
            }
            catch (error) {
                ctx.logger.warn(`dsh-do: could not block agent "${agent.id}" at its round limit: ${renderThrown(error)}`);
            }
            return;
        }
        const round = rounds + 1;
        // Claude Code's `/loop <interval>` fires its prompt immediately and then
        // repeats on that cadence. The first round therefore runs at once and only
        // later rounds wait, measured from when the previous round was queued.
        if (loop.intervalMs !== undefined && state.lastRoundAt !== undefined) {
            const wait = state.lastRoundAt + loop.intervalMs - Date.now();
            if (wait > 0) {
                // Wake on the remaining interval. The re-driven pass re-reads the loop,
                // so a pause, edit, cancel, or teardown during the wait is honoured
                // instead of queueing a stale round.
                clearPace(state);
                state.paceTimer = setTimeout(() => {
                    state.paceTimer = undefined;
                    requestDrive(state);
                }, Math.min(wait, MAX_TIMER_DELAY_MS));
                return;
            }
        }
        const content = renderLoopRoundPrompt(loop.objective, round, loop.maxRounds);
        const message = createUserMessage({ content, source: { kind: 'loop', loopId: loop.id, round } });
        state.attempt = { loopId: loop.id, round, messageId: message.id, content, phase: 'queued', stale: false, cancelled: false };
        try {
            agent.followup(message);
            state.lastRoundAt = Date.now();
        }
        catch (error) {
            state.attempt = undefined;
            ctx.logger.warn(`dsh-do: could not queue round ${round} for agent "${agent.id}": ${renderThrown(error)}`);
            const latest = loopOf(state);
            if (latest !== undefined && latest.id === loop.id && latest.phase === 'active' && latest.armed) {
                try {
                    controller.block(agent.session.id, 'queue-failed', `Could not queue loop round ${round}: ${renderThrown(error)}`);
                }
                catch (blockError) {
                    ctx.logger.warn(`dsh-do: could not block agent "${agent.id}" after a queue failure: ${renderThrown(blockError)}`);
                }
            }
        }
    }
    /** Coalesce triggers onto one agent-local serialized driver. */
    function requestDrive(state) {
        if (state.stopping)
            return;
        state.requested = true;
        if (state.run !== undefined)
            return;
        let run;
        try {
            run = ctx.agents.withoutInitiator(async () => {
                while (state.requested && !state.stopping) {
                    state.requested = false;
                    try {
                        await drive(state);
                    }
                    catch (error) {
                        ctx.logger.warn(`dsh-do: driver failed for agent "${state.agent.id}": ${renderThrown(error)}`);
                        disarm(state, { code: 'driver-failed', message: `the loop driver failed: ${renderThrown(error)}` });
                    }
                }
            });
        }
        catch (error) {
            ctx.logger.warn(`dsh-do: could not start driver for agent "${state.agent.id}": ${renderThrown(error)}`);
            disarm(state, { code: 'driver-failed', message: `the loop driver could not start: ${renderThrown(error)}` });
            return;
        }
        state.run = run;
        const retire = () => {
            state.run = undefined;
            if (state.requested && !state.stopping)
                requestDrive(state);
        };
        run.then(retire, (error) => {
            ctx.logger.warn(`dsh-do: driver task rejected for agent "${state.agent.id}": ${renderThrown(error)}`);
            disarm(state, { code: 'driver-failed', message: `the loop driver task was rejected: ${renderThrown(error)}` });
            retire();
        });
    }
    ctx.effect(async function* () {
        if (restore !== undefined)
            await restore;
        ctx.on('agent/error', ({ agent }) => {
            disarm(stateFor(agent), { code: 'agent-error', message: 'the agent reported an error while the loop was running' });
        });
        ctx.on('agent/created', ({ agent }) => {
            stateFor(agent);
        });
        ctx.on('agent/disposed', ({ agent }) => {
            states.delete(agent);
        });
        ctx.on('agent/session-start', ({ agent }) => {
            const state = stateFor(agent);
            state.attempt = undefined;
            state.competingQueued = false;
            // A checkpoint restored at startup is read straight into the registry and
            // never passes through a change notification, and an agent that starts
            // after install misses the catch-up pass below. Without this nudge an
            // armed loop that survived a restart would sit silent until some
            // unrelated turn happened to make the agent idle again.
            requestDrive(state);
        });
        ctx.on('agent/status', ({ agent, status }) => {
            const state = stateFor(agent);
            if (status === 'idle') {
                state.competingQueued = false;
                const attempt = state.attempt;
                const loop = loopOf(state);
                // A round that was cancelled (user or parent) disarms the loop so it
                // does not fight the user; loop_start re-arms it later.
                if ((attempt?.phase === 'queued' || attempt?.phase === 'claimed' || attempt?.cancelled) && loop?.phase === 'active' && loop.armed) {
                    const cancelledRound = attempt.round;
                    state.attempt = undefined;
                    // Route through disarm() so the stop is recorded AND announced:
                    // this is the path a real cancelled round takes, and it is the one
                    // that used to leave the loop silently stopped.
                    disarm(state, {
                        code: 'round-cancelled',
                        message: `round ${cancelledRound} was cancelled before it could run, so the loop stopped instead of retrying it`,
                    });
                }
                requestDrive(state);
            }
        });
        ctx.on('agent/inbox/inserted', ({ agent, message }) => {
            if (!agent.inbox.nextTurn.some((candidate) => candidate.id === message.id))
                return;
            const state = stateFor(agent);
            const attempt = state.attempt;
            if (attempt !== undefined && isLoopSource(message.source) && sameQueued(message.content, message.source, attempt))
                return;
            state.competingQueued = true;
            if (attempt?.phase === 'queued')
                attempt.stale = true;
        });
        ctx.on('agent/inbox/claimed', ({ agent, message }) => {
            const attempt = stateFor(agent).attempt;
            if (attempt !== undefined && isLoopSource(message.source) && sameQueued(message.content, message.source, attempt)) {
                attempt.phase = 'claimed';
            }
        });
        ctx.on('agent/inbox/discarded', ({ agent, message }) => {
            const attempt = stateFor(agent).attempt;
            if (attempt !== undefined && isLoopSource(message.source) && sameQueued(message.content, message.source, attempt)) {
                attempt.cancelled = true;
            }
        });
        ctx.on('session/event', (session, event) => {
            const agent = ctx.agents.get(session.id);
            if (agent === undefined || agent.session !== session)
                return;
            const state = stateFor(agent);
            if (event.type === 'user/message') {
                const source = event.data.source;
                // A human message starts a new piece of work: the continuation budget
                // belongs to one cut-off answer, not to the whole session.
                if (source?.kind === 'user')
                    state.continueStreak = 0;
                if (isLoopSource(source)) {
                    if (state.attempt !== undefined && state.attempt.messageId === event.data.id)
                        state.attempt.phase = 'admitted';
                    controller.recordAdmitted(session.id, source.loopId, source.round);
                }
                return;
            }
            if (event.type !== 'turn/end')
                return;
            const reason = event.data.reason;
            if (reason.kind === 'max-tokens') {
                const loop = loopOf(state);
                const looping = loop !== undefined && loop.phase === 'active' && loop.armed;
                const policy = options.autoContinue?.();
                if (policy !== undefined) {
                    const decision = decideAutoContinue(policy, state.continueStreak, looping);
                    if (decision.kind === 'continue') {
                        // Ask for the rest of the cut-off answer as a new turn. While it is
                        // pending the inbox is non-empty, so the driver does not queue the
                        // next round on top of it; the round count is not spent.
                        try {
                            state.agent.followup(createUserMessage({
                                content: renderAutoContinuePrompt(decision.attempt, policy.maxContinuations),
                                source: {
                                    ...PLUGIN_SOURCE,
                                    form: 'notice',
                                    summary: boundContextSummary(`dsh-do output limit: continue ${decision.attempt}/${policy.maxContinuations}`),
                                },
                            }));
                            state.continueStreak = decision.attempt;
                            return;
                        }
                        catch (error) {
                            ctx.logger.warn(`dsh-do: could not queue an output-limit continuation for agent "${agent.id}": ${renderThrown(error)}`);
                        }
                    }
                    else if (decision.reason === 'exhausted') {
                        state.continueStreak = 0;
                        disarm(state, { code: 'max-tokens', message: describeAutoContinueStop('exhausted', policy.maxContinuations) });
                        return;
                    }
                }
                // Without (or past) auto-continue this is the harness goal-driver
                // contract: an armed loop stops at an output-limit cut-off.
                state.continueStreak = 0;
                disarm(state, { code: 'max-tokens', message: 'the last round hit the model output limit, so the loop stopped instead of retrying it' });
                return;
            }
            state.continueStreak = 0;
            if (reason.kind !== 'aborted')
                return;
            if (state.attempt?.phase === 'claimed' || state.attempt?.phase === 'admitted')
                state.attempt.cancelled = true;
            else {
                disarm(state, { code: 'round-aborted', message: 'the running turn was aborted, so the loop stopped instead of retrying it' });
            }
        });
        ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
            const submitted = messages.find((message) => isLoopSource(message.source));
            if (submitted === undefined || !isLoopSource(submitted.source))
                return next();
            const { content, source } = submitted;
            const state = stateFor(agent);
            let valid = false;
            try {
                valid = validReservation(state, content, source);
            }
            catch (error) {
                ctx.logger.warn(`dsh-do: pre-step check failed for agent "${agent.id}": ${renderThrown(error)}`);
                disarm(state, { code: 'driver-failed', message: `the round reservation could not be verified: ${renderThrown(error)}` });
            }
            if (!valid) {
                const attempt = state.attempt;
                if (attempt !== undefined && source.loopId === attempt.loopId && source.round === attempt.round) {
                    attempt.stale = true;
                    state.attempt = undefined;
                }
                restoreOtherClaimed(agent, messages, submitted.id);
                requestDrive(state);
                return { kind: 'reject' };
            }
            let decision;
            try {
                decision = await next();
            }
            catch (error) {
                if (signal.aborted)
                    throw error;
                state.attempt = undefined;
                requestDrive(state);
                throw error;
            }
            if (signal.aborted) {
                if (decision.kind === 'enter')
                    restoreOtherClaimed(agent, decision.messages, submitted.id);
                return decision;
            }
            if (decision.kind === 'reject') {
                state.attempt = undefined;
                const loop = loopOf(state);
                if (loop !== undefined && loop.id === source.loopId && loop.phase === 'active' && loop.armed) {
                    try {
                        controller.block(agent.session.id, 'prompt-rejected', 'Loop round was rejected before entering its step.');
                    }
                    catch (error) {
                        ctx.logger.warn(`dsh-do: could not block agent "${agent.id}" after a rejected round: ${renderThrown(error)}`);
                    }
                }
                return decision;
            }
            try {
                valid = validReservation(state, content, source);
            }
            catch (error) {
                ctx.logger.warn(`dsh-do: post-decision check failed for agent "${agent.id}": ${renderThrown(error)}`);
                disarm(state, { code: 'driver-failed', message: `the round reservation could not be re-verified: ${renderThrown(error)}` });
                valid = false;
            }
            if (!valid) {
                state.attempt = undefined;
                restoreOtherClaimed(agent, decision.messages, submitted.id);
                requestDrive(state);
                return { kind: 'reject' };
            }
            return decision;
        });
        for (const agent of ctx.agents.list()) {
            stateFor(agent);
            requestDrive(stateFor(agent));
        }
        yield async () => {
            const waits = [];
            for (const state of states.values()) {
                state.stopping = true;
                // A teardown is a process shutdown, not a decision: record why so a
                // loop that comes back disarmed can say a restart stopped it.
                disarm(state, { code: 'restart', message: 'the harness shut down while this loop was armed' });
                const attempt = state.attempt;
                if (attempt !== undefined) {
                    attempt.stale = true;
                    if (state.agent.status === 'running') {
                        state.agent.cancel({ kind: 'parent' });
                        waits.push(state.agent.whenIdle());
                    }
                }
                if (state.run !== undefined)
                    waits.push(state.run);
            }
            await Promise.allSettled(waits);
            states.clear();
        };
    }, 'dsh-do.driver()');
    /**
     * Resolve one session's live agent and re-run the driven pass. Called by the
     * controller's change sink, because starting a loop emits no agent lifecycle
     * event: `/loop <objective>` typed into an idle session would otherwise stay
     * armed with zero rounds started until something else made the agent idle.
     */
    function nudge(sessionId) {
        const agent = ctx.agents.get(SessionId(sessionId));
        if (agent === undefined)
            return;
        requestDrive(stateFor(agent));
    }
    return { nudge };
}
//# sourceMappingURL=driver.js.map