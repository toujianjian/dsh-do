/**
 * Owner of the session-keyed loop registry and its durable checkpoints.
 * Every mutation is applied to the live map and then published through the
 * store; persistence failures are logged but never fail the mutation.
 *
 * @module dsh-do/controller
 */
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { LoopStore } from './checkpoint.js'
import {
	armLoop,
	createLoop,
	editLoopObjective,
	markBlocked,
	markCancelled,
	markCompleted,
	markPaused,
	markRoundAdmitted,
	type LoopPauseReason,
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
 * Sink notified after any commit that leaves an **armed active** loop.
 *
 * Starting, replacing, or resuming a loop produces no agent lifecycle
 * transition of its own — a slash command runs without a turn, so the agent is
 * already idle and stays idle. The round-continuation driver wakes only on
 * lifecycle events, so without this signal a freshly armed loop sits at zero
 * started rounds until some unrelated event makes the agent idle again.
 * Claude Code's `/loop` states the contract plainly: run the prompt
 * immediately, don't wait for the first scheduled fire.
 */
export type LoopChangeNotifier = (loop: LoopState) => void

/**
 * Session-keyed loop registry. One loop per session; `start` creates a fresh
 * loop, re-arms a disarmed active loop, or replaces a terminal one.
 */
export class LoopController {
	private readonly loops = new Map<string, LoopState>()
	private store: LoopStore | undefined
	private notifier: LoopChangeNotifier | undefined

	constructor(store: LoopStore | undefined, private readonly logger: LoopLogger) {
		this.store = store
	}

	/**
	 * Register the sink that wakes the driver whenever a loop becomes armed and
	 * active. Passing `undefined` detaches it, so a disposed driver is never
	 * called after teardown.
	 * @param notifier - the change sink, or `undefined` to detach.
	 */
	setNotifier(notifier: LoopChangeNotifier | undefined): void {
		this.notifier = notifier
	}

	/**
	 * Swap the durable store, e.g. after the user changes `persist` or
	 * `checkpointDir`. In-memory loops are untouched: a store swap changes where
	 * subsequent writes land, not which loops exist. Passing `undefined` disables
	 * persistence without dropping live state.
	 * @param store - the next store, or `undefined` for memory-only operation.
	 */
	useStore(store: LoopStore | undefined): void {
		this.store = store
	}

	/** Load persisted loops into the registry. Idempotent; call once at startup. */
	async restore(): Promise<void> {
		if (this.store === undefined) return
		const loaded = await this.store.load()
		for (const [sessionId, loop] of loaded) this.loops.set(sessionId, loop)
		if (loaded.size > 0) this.logger.info(`dsh-do: restored ${loaded.size} checkpointed loop(s)`)
	}

	get(sessionId: string): LoopState | undefined {
		return this.loops.get(sessionId)
	}

	/** Every live loop, for a status surface that has no session in hand. */
	list(): readonly LoopState[] {
		return [...this.loops.values()]
	}

	/**
	 * Start the session's loop. A terminal or disarmed loop is **replaced
	 * outright**: `loop_start` and `/loop <objective>` both mean "run THIS
	 * objective", so a paused loop must not silently keep its old text and
	 * budget. An armed loop is never clobbered — inspect, edit, pause, cancel,
	 * or let it finish first.
	 *
	 * Replacement mints a fresh loop id on purpose. Admitted rounds are counted
	 * from session events tagged with that id, so a new id is what actually
	 * resets the budget; it also invalidates any in-flight reservation still
	 * carrying the old id, so a queued round from the previous loop can never be
	 * admitted into the new one.
	 */
	start(sessionId: string, objective: string, maxRounds: number, intervalMs?: number): LoopState {
		const existing = this.loops.get(sessionId)
		if (existing !== undefined && existing.phase === 'active' && existing.armed) {
			throw new HarnessError(
				'a loop is already active for this session; inspect it with loop_status, change its objective with /loop edit, stop it with loop_cancel, or let it finish',
				LOOP_ERROR.ALREADY_ACTIVE,
			)
		}
		const loop = createLoop({ sessionId, objective, maxRounds, ...(intervalMs === undefined ? {} : { intervalMs }) })
		return this.commit(loop)
	}

	/**
	 * Replace the active loop's objective in place, keeping its phase, arming,
	 * admitted rounds and cadence. This is the mid-flight correction path: use it
	 * when the budget already spent should still count, whereas `start` replaces
	 * the loop and resets the budget.
	 */
	editObjective(sessionId: string, objective: string): LoopState {
		return this.commit(editLoopObjective(this.requireActive(sessionId, 'loop edit'), objective))
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

	/**
	 * Arm or disarm the loop without changing its phase. Disarming records why,
	 * so an active-but-stopped loop can explain itself.
	 * @param reason - cause of the disarm; omitted only when re-arming.
	 */
	arm(sessionId: string, armed: boolean, reason?: Omit<LoopPauseReason, 'at'>): LoopState | undefined {
		const loop = this.loops.get(sessionId)
		if (loop === undefined) return undefined
		return this.commit(armLoop(loop, armed, reason))
	}

	/** Bump the highest admitted round and persist. */
	recordAdmitted(sessionId: string, loopId: string, round: number): void {
		const loop = this.loops.get(sessionId)
		if (loop === undefined || loop.id !== loopId) return
		this.commit(markRoundAdmitted(loop, round))
	}

	/** Record why an already-disarmed active loop stopped. */
	recordPaused(sessionId: string, reason: Omit<LoopPauseReason, 'at'>): LoopState | undefined {
		const loop = this.loops.get(sessionId)
		if (loop === undefined || loop.phase !== 'active' || loop.armed) return undefined
		return this.commit(markPaused(loop, reason))
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
				this.logger.warn(`dsh-do: checkpoint write failed for loop ${loop.id}: ${String(error)}`)
			})
		}
		// Only an armed active loop has work for the driver. Terminal transitions
		// (complete/block/cancel) and pausing are deliberately silent.
		if (loop.phase === 'active' && loop.armed) {
			try {
				this.notifier?.(loop)
			} catch (error) {
				// A failing sink must never fail the mutation that caused it.
				this.logger.warn(`dsh-do: loop change notification failed for loop ${loop.id}: ${String(error)}`)
			}
		}
		return loop
	}
}
