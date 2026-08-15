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
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { LoopController } from './controller.js'
import { effectiveRounds, isLoopSource, type LoopMessageSource, type LoopState } from './loop.js'
import { renderLoopRoundPrompt } from './prompt.js'

/** One queued/claimed/admitted round reservation owned by the driver. */
interface Attempt {
	readonly loopId: string
	readonly round: number
	readonly messageId: string
	readonly content: ContentBlock[]
	phase: 'queued' | 'claimed' | 'admitted'
	stale: boolean
	cancelled: boolean
}

/** Per-agent driver bookkeeping. */
interface PerAgentState {
	readonly agent: Agent
	attempt: Attempt | undefined
	competingQueued: boolean
	requested: boolean
	run: Promise<void> | undefined
	stopping: boolean
}

function renderThrown(value: unknown): string {
	return value instanceof Error ? value.message : String(value)
}

/** Whether the queued record matches one exact reservation. */
function sameQueued(content: ContentBlock[], source: LoopMessageSource, attempt: Attempt): boolean {
	return source.loopId === attempt.loopId && source.round === attempt.round && isDeepStrictEqual(content, attempt.content)
}

/**
 * Install the round-continuation driver for one plugin context. The driver
 * effect owns its teardown (joins every in-flight run, disarms every loop).
 * When `restore` is supplied, listeners are installed only after it settles,
 * and agents already idle at that point are nudged so a restored armed loop
 * resumes without waiting for the next status transition.
 */
export function installLoopDriver(ctx: Context, controller: LoopController, restore?: Promise<void>): void {
	const states = new Map<Agent, PerAgentState>()

	function stateFor(agent: Agent): PerAgentState {
		let state = states.get(agent)
		if (state === undefined) {
			state = {
				agent,
				attempt: undefined,
				competingQueued: false,
				requested: false,
				run: undefined,
				stopping: false,
			}
			states.set(agent, state)
		}
		return state
	}

	/** Read only when the exact Agent remains live. */
	function loopOf(state: PerAgentState): LoopState | undefined {
		if (ctx.agents.get(state.agent.id) !== state.agent) return undefined
		return controller.get(state.agent.session.id)
	}

	/** Whether this exact lifecycle is quiescent with no competing prompt. */
	function readyToDrive(state: PerAgentState): boolean {
		return (
			ctx.fiber.state === 2 &&
			!state.stopping &&
			ctx.agents.get(state.agent.id) === state.agent &&
			state.agent.status === 'idle' &&
			!state.competingQueued
		)
	}

	/** Remove automatic authority while preserving the durable phase. */
	function disarm(state: PerAgentState): void {
		try {
			const loop = loopOf(state)
			if (loop !== undefined && loop.armed) controller.arm(state.agent.session.id, false)
		} catch (error) {
			ctx.logger.warn(`dsh-do: could not disarm agent "${state.agent.id}": ${renderThrown(error)}`)
		}
	}

	/** Preserve claimed step context when the driver drops only its own round. */
	function restoreOtherClaimed(agent: Agent, messages: readonly UserMessage[], messageId: string): void {
		const retained = messages.filter((message) => message.id !== messageId && !isLoopSource(message.source))
		for (const message of retained.toReversed()) {
			if (
				agent.inbox.nextStep.some((candidate) => candidate.id === message.id) ||
				agent.inbox.nextTurn.some((candidate) => candidate.id === message.id)
			) {
				continue
			}
			agent.inbox.prepend('next-step', message)
		}
	}

	/** Fail closed unless the queued prompt still owns the exact live revision. */
	function validReservation(state: PerAgentState, content: ContentBlock[], source: LoopMessageSource): boolean {
		const attempt = state.attempt
		const loop = loopOf(state)
		return (
			ctx.fiber.state === 2 &&
			!state.stopping &&
			attempt !== undefined &&
			attempt.phase === 'claimed' &&
			!attempt.stale &&
			sameQueued(content, source, attempt) &&
			loop !== undefined &&
			loop.id === source.loopId &&
			loop.phase === 'active' &&
			loop.armed &&
			source.round === effectiveRounds(state.agent, loop) + 1
		)
	}

	/** Process admitted work at quiescence, then reserve at most one next round. */
	async function drive(state: PerAgentState): Promise<void> {
		const { agent } = state
		if (!readyToDrive(state)) return
		if (state.attempt !== undefined) {
			state.attempt = undefined
			state.requested = true
			return
		}
		const loop = loopOf(state)
		if (loop === undefined || loop.phase !== 'active' || !loop.armed) return
		const rounds = effectiveRounds(agent, loop)
		if (rounds >= loop.maxRounds) {
			try {
				controller.block(agent.session.id, 'round-limit', `Loop reached its configured limit of ${loop.maxRounds} rounds.`)
			} catch (error) {
				ctx.logger.warn(`dsh-do: could not block agent "${agent.id}" at its round limit: ${renderThrown(error)}`)
			}
			return
		}
		const round = rounds + 1
		const content = renderLoopRoundPrompt(loop.objective, round, loop.maxRounds)
		const message = createUserMessage({ content, source: { kind: 'loop', loopId: loop.id, round } })
		state.attempt = { loopId: loop.id, round, messageId: message.id, content, phase: 'queued', stale: false, cancelled: false }
		try {
			agent.followup(message)
		} catch (error) {
			state.attempt = undefined
			ctx.logger.warn(`dsh-do: could not queue round ${round} for agent "${agent.id}": ${renderThrown(error)}`)
			const latest = loopOf(state)
			if (latest !== undefined && latest.id === loop.id && latest.phase === 'active' && latest.armed) {
				try {
					controller.block(agent.session.id, 'queue-failed', `Could not queue loop round ${round}: ${renderThrown(error)}`)
				} catch (blockError) {
					ctx.logger.warn(`dsh-do: could not block agent "${agent.id}" after a queue failure: ${renderThrown(blockError)}`)
				}
			}
		}
	}

	/** Coalesce triggers onto one agent-local serialized driver. */
	function requestDrive(state: PerAgentState): void {
		if (state.stopping) return
		state.requested = true
		if (state.run !== undefined) return
		let run: Promise<void>
		try {
			run = ctx.agents.withoutInitiator(async () => {
				while (state.requested && !state.stopping) {
					state.requested = false
					try {
						await drive(state)
					} catch (error) {
						ctx.logger.warn(`dsh-do: driver failed for agent "${state.agent.id}": ${renderThrown(error)}`)
						disarm(state)
					}
				}
			})
		} catch (error) {
			ctx.logger.warn(`dsh-do: could not start driver for agent "${state.agent.id}": ${renderThrown(error)}`)
			disarm(state)
			return
		}
		state.run = run
		const retire = () => {
			state.run = undefined
			if (state.requested && !state.stopping) requestDrive(state)
		}
		run.then(retire, (error) => {
			ctx.logger.warn(`dsh-do: driver task rejected for agent "${state.agent.id}": ${renderThrown(error)}`)
			disarm(state)
			retire()
		})
	}

	ctx.effect(async function* () {
		if (restore !== undefined) await restore
		ctx.on('agent/error', ({ agent }) => {
			disarm(stateFor(agent))
		})
		ctx.on('agent/created', ({ agent }) => {
			stateFor(agent)
		})
		ctx.on('agent/disposed', ({ agent }) => {
			states.delete(agent)
		})
		ctx.on('agent/session-start', ({ agent }) => {
			const state = stateFor(agent)
			state.attempt = undefined
			state.competingQueued = false
		})
		ctx.on('agent/status', ({ agent, status }) => {
			const state = stateFor(agent)
			if (status === 'idle') {
				state.competingQueued = false
				const attempt = state.attempt
				const loop = loopOf(state)
				// A round that was cancelled (user or parent) disarms the loop so it
				// does not fight the user; loop_start re-arms it later.
				if ((attempt?.phase === 'queued' || attempt?.phase === 'claimed' || attempt?.cancelled) && loop?.phase === 'active' && loop.armed) {
					state.attempt = undefined
					try {
						controller.arm(agent.session.id, false)
					} catch (error) {
						ctx.logger.warn(`dsh-do: could not disarm agent "${agent.id}" after a cancelled round: ${renderThrown(error)}`)
						disarm(state)
					}
				}
				requestDrive(state)
			}
		})
		ctx.on('agent/inbox/inserted', ({ agent, message }) => {
			if (!agent.inbox.nextTurn.some((candidate) => candidate.id === message.id)) return
			const state = stateFor(agent)
			const attempt = state.attempt
			if (attempt !== undefined && isLoopSource(message.source) && sameQueued(message.content, message.source, attempt)) return
			state.competingQueued = true
			if (attempt?.phase === 'queued') attempt.stale = true
		})
		ctx.on('agent/inbox/claimed', ({ agent, message }) => {
			const attempt = stateFor(agent).attempt
			if (attempt !== undefined && isLoopSource(message.source) && sameQueued(message.content, message.source, attempt)) {
				attempt.phase = 'claimed'
			}
		})
		ctx.on('agent/inbox/discarded', ({ agent, message }) => {
			const attempt = stateFor(agent).attempt
			if (attempt !== undefined && isLoopSource(message.source) && sameQueued(message.content, message.source, attempt)) {
				attempt.cancelled = true
			}
		})
		ctx.on('session/event', (session, event) => {
			const agent = ctx.agents.get(session.id)
			if (agent === undefined || agent.session !== session) return
			const state = stateFor(agent)
			if (event.type === 'user/message') {
				const source = event.data.source
				if (isLoopSource(source)) {
					if (state.attempt !== undefined && state.attempt.messageId === event.data.id) state.attempt.phase = 'admitted'
					controller.recordAdmitted(session.id, source.loopId, source.round)
				}
				return
			}
			if (event.type !== 'turn/end') return
			const reason = event.data.reason
			if (reason.kind === 'max-tokens') {
				disarm(state)
				return
			}
			if (reason.kind !== 'aborted') return
			if (state.attempt?.phase === 'claimed' || state.attempt?.phase === 'admitted') state.attempt.cancelled = true
			else disarm(state)
		})
		ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
			const submitted = messages.find((message) => isLoopSource(message.source))
			if (submitted === undefined || !isLoopSource(submitted.source)) return next()
			const { content, source } = submitted
			const state = stateFor(agent)
			let valid = false
			try {
				valid = validReservation(state, content, source)
			} catch (error) {
				ctx.logger.warn(`dsh-do: pre-step check failed for agent "${agent.id}": ${renderThrown(error)}`)
				disarm(state)
			}
			if (!valid) {
				const attempt = state.attempt
				if (attempt !== undefined && source.loopId === attempt.loopId && source.round === attempt.round) {
					attempt.stale = true
					state.attempt = undefined
				}
				restoreOtherClaimed(agent, messages, submitted.id)
				requestDrive(state)
				return { kind: 'reject' }
			}
			let decision: PreStepDecision
			try {
				decision = await next()
			} catch (error) {
				if (signal.aborted) throw error
				state.attempt = undefined
				requestDrive(state)
				throw error
			}
			if (signal.aborted) {
				if (decision.kind === 'enter') restoreOtherClaimed(agent, decision.messages, submitted.id)
				return decision
			}
			if (decision.kind === 'reject') {
				state.attempt = undefined
				const loop = loopOf(state)
				if (loop !== undefined && loop.id === source.loopId && loop.phase === 'active' && loop.armed) {
					try {
						controller.block(agent.session.id, 'prompt-rejected', 'Loop round was rejected before entering its step.')
					} catch (error) {
						ctx.logger.warn(`dsh-do: could not block agent "${agent.id}" after a rejected round: ${renderThrown(error)}`)
					}
				}
				return decision
			}
			try {
				valid = validReservation(state, content, source)
			} catch (error) {
				ctx.logger.warn(`dsh-do: post-decision check failed for agent "${agent.id}": ${renderThrown(error)}`)
				disarm(state)
				valid = false
			}
			if (!valid) {
				state.attempt = undefined
				restoreOtherClaimed(agent, decision.messages, submitted.id)
				requestDrive(state)
				return { kind: 'reject' }
			}
			return decision
		})

		for (const agent of ctx.agents.list()) {
			stateFor(agent)
			requestDrive(stateFor(agent))
		}

		yield async () => {
			const waits: Promise<unknown>[] = []
			for (const state of states.values()) {
				state.stopping = true
				disarm(state)
				const attempt = state.attempt
				if (attempt !== undefined) {
					attempt.stale = true
					if (state.agent.status === 'running') {
						state.agent.cancel({ kind: 'parent' })
						waits.push(state.agent.whenIdle())
					}
				}
				if (state.run !== undefined) waits.push(state.run)
			}
			await Promise.allSettled(waits)
			states.clear()
		}
	}, 'dsh-do.driver()')
}
