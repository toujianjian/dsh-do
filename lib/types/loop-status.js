import { effectiveRounds } from './loop.js';
/**
 * Schema for the projection cell. A schemastery-shaped `parse` is all the
 * registry requires; it validates on every snapshot read.
 */
const loopProjectionSchema = {
    parse(value) {
        if (value === null || value === undefined)
            return null;
        const state = value;
        if (typeof state.loopId !== 'string' && state.loopId !== null)
            throw new TypeError('loop projection: invalid loopId');
        if (!Number.isSafeInteger(state.roundsStarted) || state.roundsStarted < 0)
            throw new TypeError('loop projection: invalid roundsStarted');
        return state;
    },
};
/**
 * Pure fold of one loop round event into the projection state. Replay-safe by
 * construction: it depends only on the events, never on live plugin state.
 */
export function applyLoopProjection(state, event) {
    if (event.type !== 'user/message')
        return state;
    const source = event.data?.source;
    if (source?.kind !== 'loop' || typeof source.loopId !== 'string' || !Number.isSafeInteger(source.round))
        return state;
    const round = source.round;
    // A new loop id restarts the fold: rounds from a replaced loop must not
    // inflate the new loop's progress.
    if (state !== null && state.loopId !== null && state.loopId !== source.loopId) {
        return { loopId: source.loopId, roundsStarted: round, lastRoundAt: null };
    }
    if (state !== null && round <= state.roundsStarted)
        return state;
    return { loopId: source.loopId, roundsStarted: round, lastRoundAt: state?.lastRoundAt ?? null };
}
/**
 * Build the flat, JSON-only view of one loop. Reads leaf fields and constructs
 * an owned object: no live Cordis/DSH object crosses this boundary.
 * @param agent - live agent owning the loop, used for durable round accounting.
 */
export function loopStatusView(loop, agent) {
    const roundsStarted = effectiveRounds(agent, loop);
    return {
        phase: loop.phase,
        armed: loop.armed,
        loopId: loop.id,
        roundsStarted,
        maxRounds: loop.maxRounds,
        objective: loop.objective,
        ...(loop.intervalMs === undefined ? {} : { intervalMs: loop.intervalMs }),
        // A pause only means something while the loop is still active and stopped.
        ...(loop.pausedReason === undefined || loop.phase !== 'active' || loop.armed
            ? {}
            : { pausedReason: { code: loop.pausedReason.code, message: loop.pausedReason.message, at: loop.pausedReason.at } }),
        ...(loop.completedSummary === undefined ? {} : { completedSummary: loop.completedSummary }),
        ...(loop.blockedReason === undefined ? {} : { blockedReason: { code: loop.blockedReason.code, message: loop.blockedReason.message } }),
        ...(loop.cancelledReason === undefined ? {} : { cancelledReason: loop.cancelledReason }),
    };
}
/**
 * One-line human summary, shared by every surface so the wording of a stop is
 * identical in the client panel, the TUI status line, and the model's own
 * `loop_status` output.
 */
export function renderLoopStatusLine(view) {
    const progress = `round ${view.roundsStarted}/${view.maxRounds}`;
    if (view.phase !== 'active') {
        const outcome = view.completedSummary ?? view.blockedReason?.message ?? view.cancelledReason;
        return `loop ${view.phase} · ${progress}${outcome === undefined ? '' : ` · ${outcome}`}`;
    }
    if (!view.armed) {
        const paused = view.pausedReason;
        return `loop paused · ${progress}${paused === undefined ? '' : ` · ${paused.message}`}`;
    }
    const pace = view.intervalMs === undefined ? '' : ` · every ${Math.round(view.intervalMs / 1000)}s`;
    return `loop running · ${progress}${pace}`;
}
/**
 * Install the loop status surface: a `loops` service and a `loop` session
 * projection. Both are effects of the calling fiber, so unloading the plugin
 * removes the service, the projection key, and every snapshot contribution.
 * @param controller - the loop registry this surface reports on.
 */
export function installLoopStatus(ctx, controller) {
    // The service exists for terminals that read live services (the same way the
    // TUI reads `goals`); the projection exists for carriers that consume the
    // registry. Neither is required, so a profile without the registry still
    // gets the service.
    ctx.provide('loops');
    ctx.set('loops', {
        get(agent) {
            const loop = controller.get(agent.session.id);
            return loop === undefined ? undefined : loopStatusView(loop, agent);
        },
        list() {
            const views = new Map();
            for (const loop of controller.list()) {
                views.set(loop.sessionId, loopStatusView(loop));
            }
            return views;
        },
    });
    ctx.inject(['sessionProjections'], (projectionCtx) => {
        const registry = projectionCtx.sessionProjections;
        if (registry === undefined)
            return;
        registry.register({
            key: 'loop',
            schema: loopProjectionSchema,
            init: () => null,
            // A projection cell is a PURE fold over the session log, and the registry
            // rebuilds it by replaying from seq 0. Reading the live controller here
            // would make the value depend on when it was replayed, so this unit folds
            // only the durable loop rounds. Arming and the pause cause are not in the
            // log; they are read from the `loops` service instead.
            apply: applyLoopProjection,
            view: (state) => state,
            stateVersion: 1,
        });
    });
}
//# sourceMappingURL=loop-status.js.map