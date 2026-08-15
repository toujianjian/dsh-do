/**
 * Pure loop domain: durable state shape, identities, and deterministic
 * transitions. No runtime dependency beyond `node:crypto`; type-only imports
 * keep the module side-effect free.
 *
 * @module dsh-do/loop
 */
import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'

/** Stable identity of one loop. */
export type LoopId = string & { readonly __loopId: unique symbol }

/** Mint a loop identity from its string form. */
export function LoopId(value: string): LoopId {
	return value as LoopId
}

/** Lifecycle phase of a loop. */
export type LoopPhase = 'active' | 'completed' | 'blocked' | 'cancelled'

/** Structured reason a loop was blocked. */
export interface LoopBlockedReason {
	readonly code: string
	readonly message: string
}

/**
 * Durable state of one Claude Code-style loop, owned by one session.
 * Every field is immutable; transitions return a new snapshot.
 */
export interface LoopState {
	readonly id: LoopId
	/** The agent/session identity the loop rides on. */
	readonly sessionId: string
	/** The concrete completion objective restated into every round prompt. */
	readonly objective: string
	/** Cap on automatic continuation rounds. */
	readonly maxRounds: number
	readonly phase: LoopPhase
	/** Whether the driver may queue the next round automatically. */
	readonly armed: boolean
	/** Highest round admitted into the session log, last known. */
	readonly roundsStarted: number
	readonly blockedReason?: LoopBlockedReason
	readonly completedSummary?: string
	readonly cancelledReason?: string
	readonly startedAt: number
	readonly updatedAt: number
}

/** Inputs for {@link createLoop}. */
export interface CreateLoopInput {
	readonly sessionId: string
	readonly objective: string
	readonly maxRounds: number
	readonly now?: number
}

/** Create a fresh, armed, active loop. */
export function createLoop(input: CreateLoopInput): LoopState {
	const now = input.now ?? Date.now()
	return {
		id: LoopId(`loop-${randomUUID()}`),
		sessionId: input.sessionId,
		objective: input.objective,
		maxRounds: input.maxRounds,
		phase: 'active',
		armed: true,
		roundsStarted: 0,
		startedAt: now,
		updatedAt: now,
	}
}

function touch(loop: LoopState, now = Date.now()): LoopState {
	return { ...loop, updatedAt: now }
}

/** Bump the highest admitted round; no-op for non-increasing values. */
export function markRoundAdmitted(loop: LoopState, round: number, now?: number): LoopState {
	if (round <= loop.roundsStarted) return loop
	return touch({ ...loop, roundsStarted: round }, now)
}

/** Arm or disarm the loop without changing its phase. */
export function armLoop(loop: LoopState, armed: boolean, now?: number): LoopState {
	if (loop.armed === armed) return loop
	return touch({ ...loop, armed }, now)
}

/** Mark the loop completed and disarm it. */
export function markCompleted(loop: LoopState, summary?: string, now?: number): LoopState {
	return touch(
		{
			...loop,
			phase: 'completed',
			armed: false,
			...(summary === undefined ? {} : { completedSummary: summary }),
		},
		now,
	)
}

/** Mark the loop blocked and disarm it. */
export function markBlocked(loop: LoopState, reason: LoopBlockedReason, now?: number): LoopState {
	return touch({ ...loop, phase: 'blocked', armed: false, blockedReason: reason }, now)
}

/** Mark the loop cancelled and disarm it. */
export function markCancelled(loop: LoopState, reason?: string, now?: number): LoopState {
	return touch(
		{
			...loop,
			phase: 'cancelled',
			armed: false,
			...(reason === undefined ? {} : { cancelledReason: reason }),
		},
		now,
	)
}

/** Whether the loop may still accept continuation rounds. */
export function isRunning(loop: LoopState): boolean {
	return loop.phase === 'active'
}

/**
 * Model-visible source carried by one admitted loop round prompt. Declared
 * here so both the driver (which produces it) and the tools (which
 * authenticate it) share one augmentation.
 */
export interface LoopMessageSource {
	readonly kind: 'loop'
	readonly loopId: string
	/** Positive admitted continuation round. */
	readonly round: number
}

declare module '@deepseek-ai/dsh-llm' {
	interface MessageSourceMap {
		loop: LoopMessageSource
	}
}

/** Narrow an arbitrary source to a {@link LoopMessageSource}. */
export function isLoopSource(source: unknown): source is LoopMessageSource {
	return typeof source === 'object' && source !== null && (source as { kind?: unknown }).kind === 'loop'
}

/**
 * Highest loop round admitted into the session log. The durable log is the
 * ground truth for round accounting; the checkpoint's `roundsStarted` is only
 * a hint for sessions whose log is unavailable.
 */
export function admittedRounds(agent: Agent, loopId: string): number {
	let max = 0
	for (const event of agent.session.events) {
		if (event.type !== 'user/message') continue
		const source = (event.data as UserMessage).source
		if (isLoopSource(source) && source.loopId === loopId && Number.isSafeInteger(source.round) && source.round > max) {
			max = source.round
		}
	}
	return max
}

/** Effective admitted-round count: durable log wins over the checkpoint hint. */
export function effectiveRounds(agent: Agent | undefined, loop: LoopState): number {
	if (agent === undefined) return loop.roundsStarted
	return Math.max(admittedRounds(agent, loop.id), loop.roundsStarted)
}
