/**
 * Owner of the session-keyed loop registry and its durable checkpoints.
 * Every mutation is applied to the live map and then published through the
 * store; persistence failures are logged but never fail the mutation.
 *
 * @module dsh-do/controller
 */
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { armLoop, createLoop, markBlocked, markCancelled, markCompleted, markRoundAdmitted, } from './loop.js';
/** Error codes surfaced to tools and the driver. */
export const LOOP_ERROR = {
    ALREADY_ACTIVE: 'LOOP_ALREADY_ACTIVE',
    NOT_ACTIVE: 'LOOP_NOT_ACTIVE',
};
/**
 * Session-keyed loop registry. One loop per session; `start` creates a fresh
 * loop, re-arms a disarmed active loop, or replaces a terminal one.
 */
export class LoopController {
    store;
    logger;
    loops = new Map();
    constructor(store, logger) {
        this.store = store;
        this.logger = logger;
    }
    /** Load persisted loops into the registry. Idempotent; call once at startup. */
    async restore() {
        if (this.store === undefined)
            return;
        const loaded = await this.store.load();
        for (const [sessionId, loop] of loaded)
            this.loops.set(sessionId, loop);
        if (loaded.size > 0)
            this.logger.info(`dsh-do: restored ${loaded.size} checkpointed loop(s)`);
    }
    get(sessionId) {
        return this.loops.get(sessionId);
    }
    /** Create a fresh loop, or re-arm a disarmed one. Terminal loops are replaced. */
    start(sessionId, objective, maxRounds) {
        const existing = this.loops.get(sessionId);
        if (existing !== undefined && existing.phase === 'active') {
            if (existing.armed) {
                throw new HarnessError('a loop is already active for this session; inspect it with loop_status, stop it with loop_cancel, or let it finish', LOOP_ERROR.ALREADY_ACTIVE);
            }
            // Re-arm a paused loop, keeping its stored objective and budget.
            return this.commit(armLoop(existing, true));
        }
        const loop = createLoop({ sessionId, objective, maxRounds });
        return this.commit(loop);
    }
    /** Mark the loop completed and disarm it. */
    complete(sessionId, summary) {
        return this.commit(markCompleted(this.requireActive(sessionId, 'loop_done'), summary));
    }
    /** Mark the loop blocked and disarm it. */
    block(sessionId, code, message) {
        return this.commit(markBlocked(this.requireActive(sessionId, 'loop driver'), { code, message }));
    }
    /** Mark the loop cancelled and disarm it. */
    cancel(sessionId, reason) {
        return this.commit(markCancelled(this.requireActive(sessionId, 'loop_cancel'), reason));
    }
    /** Arm or disarm the loop without changing its phase. */
    arm(sessionId, armed) {
        const loop = this.loops.get(sessionId);
        if (loop === undefined)
            return undefined;
        return this.commit(armLoop(loop, armed));
    }
    /** Bump the highest admitted round and persist. */
    recordAdmitted(sessionId, loopId, round) {
        const loop = this.loops.get(sessionId);
        if (loop === undefined || loop.id !== loopId)
            return;
        this.commit(markRoundAdmitted(loop, round));
    }
    requireActive(sessionId, caller) {
        const loop = this.loops.get(sessionId);
        if (loop === undefined || loop.phase !== 'active') {
            throw new HarnessError(`${caller} requires an active loop for this session`, LOOP_ERROR.NOT_ACTIVE);
        }
        return loop;
    }
    commit(loop) {
        this.loops.set(loop.sessionId, loop);
        if (this.store !== undefined) {
            this.store.write(loop).catch((error) => {
                this.logger.warn(`dsh-do: checkpoint write failed for loop ${loop.id}: ${String(error)}`);
            });
        }
        return loop;
    }
}
//# sourceMappingURL=controller.js.map