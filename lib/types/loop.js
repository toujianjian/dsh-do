/**
 * Pure loop domain: durable state shape, identities, and deterministic
 * transitions. No runtime dependency beyond `node:crypto`; type-only imports
 * keep the module side-effect free.
 *
 * @module dsh-do/loop
 */
import { randomUUID } from 'node:crypto';
/** Mint a loop identity from its string form. */
export function LoopId(value) {
    return value;
}
/**
 * Largest delay `setTimeout` accepts, and therefore the ceiling for a loop
 * cadence: a longer one could never be scheduled. Also bounds a persisted
 * `intervalMs`, so a hand-edited checkpoint cannot request an absurd pace.
 */
export const MAX_TIMER_DELAY_MS = 2147483647;
/** Create a fresh, armed, active loop. */
export function createLoop(input) {
    const now = input.now ?? Date.now();
    return {
        id: LoopId(`loop-${randomUUID()}`),
        sessionId: input.sessionId,
        objective: input.objective,
        maxRounds: input.maxRounds,
        ...(input.intervalMs === undefined ? {} : { intervalMs: input.intervalMs }),
        phase: 'active',
        armed: true,
        roundsStarted: 0,
        startedAt: now,
        updatedAt: now,
    };
}
/**
 * Replace the loop's objective in place, keeping its phase, arming, admitted
 * rounds and cadence. A round already queued by the driver keeps the text it
 * was queued with; every round queued afterwards restates the new objective.
 */
export function editLoopObjective(loop, objective, now) {
    if (loop.objective === objective)
        return loop;
    return touch({ ...loop, objective }, now);
}
function touch(loop, now = Date.now()) {
    return { ...loop, updatedAt: now };
}
/** Bump the highest admitted round; no-op for non-increasing values. */
export function markRoundAdmitted(loop, round, now) {
    if (round <= loop.roundsStarted)
        return loop;
    return touch({ ...loop, roundsStarted: round }, now);
}
/**
 * Arm or disarm the loop without changing its phase. Arming clears any recorded
 * pause; disarming without a reason keeps the previous one, so a later
 * unexplained disarm cannot erase why the loop first stopped.
 */
export function armLoop(loop, armed, reason, now) {
    if (armed) {
        if (loop.armed && loop.pausedReason === undefined)
            return loop;
        const { pausedReason: _dropped, ...rest } = loop;
        return touch({ ...rest, armed: true }, now);
    }
    if (!loop.armed && reason === undefined)
        return loop;
    return touch({ ...loop, armed: false, ...(reason === undefined ? {} : { pausedReason: { ...reason, at: now ?? Date.now() } }) }, now);
}
/** Record why an already-disarmed active loop stopped. No-op once armed. */
export function markPaused(loop, reason, now) {
    if (loop.armed || loop.phase !== 'active')
        return loop;
    return touch({ ...loop, pausedReason: { ...reason, at: now ?? Date.now() } }, now);
}
/** Mark the loop completed and disarm it. */
export function markCompleted(loop, summary, now) {
    return touch({
        ...loop,
        phase: 'completed',
        armed: false,
        ...(summary === undefined ? {} : { completedSummary: summary }),
    }, now);
}
/** Mark the loop blocked and disarm it. */
export function markBlocked(loop, reason, now) {
    return touch({ ...loop, phase: 'blocked', armed: false, blockedReason: reason }, now);
}
/** Mark the loop cancelled and disarm it. */
export function markCancelled(loop, reason, now) {
    return touch({
        ...loop,
        phase: 'cancelled',
        armed: false,
        ...(reason === undefined ? {} : { cancelledReason: reason }),
    }, now);
}
/** Whether the loop may still accept continuation rounds. */
export function isRunning(loop) {
    return loop.phase === 'active';
}
/** Narrow an arbitrary source to a {@link LoopMessageSource}. */
export function isLoopSource(source) {
    return typeof source === 'object' && source !== null && source.kind === 'loop';
}
/**
 * Highest loop round admitted into the session log. The durable log is the
 * ground truth for round accounting; the checkpoint's `roundsStarted` is only
 * a hint for sessions whose log is unavailable.
 */
export function admittedRounds(agent, loopId) {
    let max = 0;
    for (const event of agent.session.events) {
        if (event.type !== 'user/message')
            continue;
        const source = event.data.source;
        if (isLoopSource(source) && source.loopId === loopId && Number.isSafeInteger(source.round) && source.round > max) {
            max = source.round;
        }
    }
    return max;
}
/** Effective admitted-round count: durable log wins over the checkpoint hint. */
export function effectiveRounds(agent, loop) {
    if (agent === undefined)
        return loop.roundsStarted;
    return Math.max(admittedRounds(agent, loop.id), loop.roundsStarted);
}
//# sourceMappingURL=loop.js.map