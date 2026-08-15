/**
 * Owner of the session-keyed loop registry and its durable checkpoints.
 * Every mutation is applied to the live map and then published through the
 * store; persistence failures are logged but never fail the mutation.
 *
 * @module dsh-loop/controller
 */
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { LoopStore } from './checkpoint.js'
import {
	armLoop,
	createLoop,
	markBlocked,
	markCancelled,
	markCompleted,
	markRoundAdmitted,
	type LoopState,
} from './loop.js'

/** Minimal logger surface the controller depends on. */
export interface LoopLogger {
	info(message: string): void
	warn(message: string): void
}

/** Error codes surfaced to tools and the driver. */
export const LOOP_ERROR = {
	ALREADY_ACTIVE: 'LOOP_ALREADY_ACTIVE',
	NOT_ACTIVE: 'LOOP_NOT_ACTIVE',
} as const

/**
 * Session-keyed loop registry. One loop per session; `start` creates a fresh
 * loop, re-arms a disarmed active loop, or replaces a terminal one.
 */
export class LoopController {
	private readonly loops = new Map<string, LoopState>()

	constructor(
		private readonly store: LoopStore | undefined,
		private readonly logger: LoopLogger,
	) {}

	/** Load persisted loops into the registry. Idempotent; call once at startup. */
	async restore(): Promise<void> {
		if (this.store === undefined) return
		const loaded = await this.store.load()
		for (const [sessionId, loop] of loaded) this.loops.set(sessionId, loop)
		if (loaded.size > 0) this.logger.info(`dsh-loop: restored ${loaded.size} checkpointed loop(s)`)
	}

	get(sessionId: string): LoopState | undefined {
		return this.loops.get(sessionId)
	}

	/** Create a fresh loop, or re-arm a disarmed one. Terminal loops are replaced. */
	start(sessionId: string, objective: string, maxRounds: number): LoopState {
		const existing = this.loops.get(sessionId)
		if (existing !== undefined && existing.phase === 'active') {
			if (existing.armed) {
				throw new HarnessError(
					'a loop is already active for this session; inspect it with loop_status, stop it with loop_cancel, or let it finish',
					LOOP_ERROR.ALREADY_ACTIVE,
				)
			}
			// Re-arm a paused loop, keeping its stored objective and budget.
			return this.commit(armLoop(existing, true))
		}
		const loop = createLoop({ sessionId, objective, maxRounds })
		return this.commit(loop)
	}

	/** Mark the loop completed and disarm it. */
	complete(sessionId: string, summary?: string): LoopState {
		return this.commit(markCompleted(this.requireActive(sessionId, 'loop_done'), summary))
	}

	/** Mark the loop blocked and disarm it. */
	block(sessionId: string, code: string, message: string): LoopState {
		return this.commit(markBlocked(this.requireActive(sessionId, 'loop driver'), { code, message }))
	}

	/** Mark the loop cancelled and disarm it. */
	cancel(sessionId: string, reason?: string): LoopState {
		return this.commit(markCancelled(this.requireActive(sessionId, 'loop_cancel'), reason))
	}

	/** Arm or disarm the loop without changing its phase. */
	arm(sessionId: string, armed: boolean): LoopState | undefined {
		const loop = this.loops.get(sessionId)
		if (loop === undefined) return undefined
		return this.commit(armLoop(loop, armed))
	}

	/** Bump the highest admitted round and persist. */
	recordAdmitted(sessionId: string, loopId: string, round: number): void {
		const loop = this.loops.get(sessionId)
		if (loop === undefined || loop.id !== loopId) return
		this.commit(markRoundAdmitted(loop, round))
	}

	private requireActive(sessionId: string, caller: string): LoopState {
		const loop = this.loops.get(sessionId)
		if (loop === undefined || loop.phase !== 'active') {
			throw new HarnessError(`${caller} requires an active loop for this session`, LOOP_ERROR.NOT_ACTIVE)
		}
		return loop
	}

	private commit(loop: LoopState): LoopState {
		this.loops.set(loop.sessionId, loop)
		if (this.store !== undefined) {
			this.store.write(loop).catch((error: unknown) => {
				this.logger.warn(`dsh-loop: checkpoint write failed for loop ${loop.id}: ${String(error)}`)
			})
		}
		return loop
	}
}
