/**
 * Automatic model fallback.
 *
 * When a model request fails with a triggering code (429 `RATE_LIMIT`, quota,
 * server, timeout, transport, empty response by default), the failed request is
 * re-issued against the next configured candidate model instead of ending the
 * turn with an error.
 *
 * Two agent waterfalls carry it:
 *
 * - `agent/request-error` decides. The listener calls `next()` FIRST, so the
 *   provider's own retry policy (`dsh-llm-retry`) still backs off and retries
 *   the same model; only when that chain gives up (returns no `retry`) does this
 *   module switch. Returning `{ kind: 'retry' }` makes the agent loop rebuild the
 *   request, which re-runs `agent/request`.
 * - `agent/request` applies. It is registered with `prepend` so it is the
 *   outermost listener: it lets the session's model selection resolve first and
 *   then overrides only `provider`/`model` (dropping an inherited reasoning
 *   effort the new model may not support).
 *
 * The switch is sticky for the session until a human message arrives, so a
 * rate-limited primary is not hammered again on every following step; the next
 * human turn tries the user's own model first. When every candidate has failed
 * the original error stands, exactly as without this module.
 *
 * @module dsh-do/model-fallback
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ModelFallbackSettings } from './settings.js'

/** One `provider/model` route. */
export interface ModelRoute {
	readonly provider: string
	readonly model: string
}

/**
 * Parse one candidate written as `provider/model`.
 *
 * Only the FIRST slash separates the two: model ids such as
 * `anthropic/claude-sonnet` (an OpenRouter-style id) keep their own slashes.
 *
 * @param text - the configured candidate.
 * @returns the route, or undefined for a malformed entry.
 */
export function parseModelRoute(text: string): ModelRoute | undefined {
	const trimmed = text.trim()
	const slash = trimmed.indexOf('/')
	if (slash <= 0 || slash === trimmed.length - 1) return undefined
	return { provider: trimmed.slice(0, slash).trim(), model: trimmed.slice(slash + 1).trim() }
}

/** Render a route back to its configured form. */
export function formatModelRoute(route: ModelRoute): string {
	return `${route.provider}/${route.model}`
}

/** Whether two routes name the same model. */
export function sameRoute(a: ModelRoute | undefined, b: ModelRoute | undefined): boolean {
	return a !== undefined && b !== undefined && a.provider === b.provider && a.model === b.model
}

/**
 * Pick the next candidate after a failure.
 *
 * @param policy - the live fallback settings.
 * @param failing - the route that just failed (undefined when unknown).
 * @param tried - routes already used in this episode, including the primary.
 * @param code - the normalized failure code.
 * @returns the route to switch to, or a reason it will not switch.
 */
export function chooseFallback(
	policy: ModelFallbackSettings,
	failing: ModelRoute | undefined,
	tried: readonly ModelRoute[],
	code: string,
): { readonly kind: 'switch'; readonly route: ModelRoute } | { readonly kind: 'keep'; readonly reason: 'disabled' | 'code' | 'exhausted' } {
	if (!policy.enabled) return { kind: 'keep', reason: 'disabled' }
	if (!policy.triggerCodes.includes(code)) return { kind: 'keep', reason: 'code' }
	for (const text of policy.candidates) {
		const route = parseModelRoute(text)
		if (route === undefined) continue
		if (sameRoute(route, failing)) continue
		if (tried.some((used) => sameRoute(used, route))) continue
		return { kind: 'switch', route }
	}
	return { kind: 'keep', reason: 'exhausted' }
}

/** Per-session fallback state. */
interface FallbackEpisode {
	/** The route the last request actually went to. */
	last?: ModelRoute
	/** Active override, applied to every request until a human message. */
	override?: ModelRoute
	/** Routes used since the episode began (primary first). */
	tried: ModelRoute[]
}

/** Read-only view of the fallback state, for status surfaces. */
export interface ModelFallbackView {
	readonly override?: string
	readonly tried: readonly string[]
}

/** Handle returned by {@link installModelFallback}. */
export interface ModelFallbackHandle {
	/** Current fallback state of one agent, or undefined when none is active. */
	view(agent: Agent): ModelFallbackView | undefined
}

/**
 * Install automatic model fallback.
 *
 * @param ctx - the plugin context.
 * @param policy - live reader for the fallback settings.
 * @returns a handle exposing per-agent state for status surfaces.
 */
export function installModelFallback(ctx: Context, policy: () => ModelFallbackSettings): ModelFallbackHandle {
	const episodes = new WeakMap<Agent, FallbackEpisode>()
	const episodeFor = (agent: Agent): FallbackEpisode => {
		let episode = episodes.get(agent)
		if (episode === undefined) {
			episode = { tried: [] }
			episodes.set(agent, episode)
		}
		return episode
	}

	// Outermost, so the session's own model selection resolves first and this
	// only replaces the route when a switch is active.
	ctx.on(
		'agent/request',
		async ({ agent }, next) => {
			const resolved = await next()
			const episode = episodeFor(agent)
			const override = policy().enabled ? episode.override : undefined
			if (override === undefined) {
				episode.last = { provider: resolved.provider, model: resolved.model }
				return resolved
			}
			const { reasoningEffort: _inherited, ...rest } = resolved
			episode.last = override
			return { ...rest, provider: override.provider, model: override.model }
		},
		{ prepend: true },
	)

	ctx.on(
		'agent/request-error',
		async ({ agent, failure, signal }, next) => {
			// The provider's retry policy runs first; only its give-up reaches here.
			const downstream = await next()
			if (downstream?.kind === 'retry' || signal.aborted) return downstream
			const episode = episodeFor(agent)
			const failing = episode.last
			if (failing !== undefined && !episode.tried.some((used) => sameRoute(used, failing))) episode.tried.push(failing)
			const choice = chooseFallback(policy(), failing, episode.tried, failure.code)
			if (choice.kind === 'keep') {
				if (choice.reason === 'exhausted') {
					ctx.logger.warn(`dsh-do: every fallback model failed for agent "${agent.id}" (${failure.code}); the error stands`)
				}
				return downstream
			}
			episode.override = choice.route
			episode.tried.push(choice.route)
			ctx.logger.info(
				`dsh-do: ${failing === undefined ? 'model' : formatModelRoute(failing)} failed with ${failure.code}; switching agent "${agent.id}" to ${formatModelRoute(choice.route)}`,
			)
			return { kind: 'retry' }
		},
		{ prepend: true },
	)

	// A human message is a fresh decision by the user: try their own model again.
	ctx.on('session/event', (session, event) => {
		if (event.type !== 'user/message') return
		// Only a real human message (`kind: 'user'`) resets; loop rounds, plugin
		// notices and auto-continue turns keep the switched model.
		const source = (event.data as { source?: { kind?: string } }).source
		if (source?.kind !== 'user') return
		const agent = ctx.agents.get(session.id)
		if (agent !== undefined) episodes.delete(agent)
	})

	return {
		view(agent) {
			const episode = episodes.get(agent)
			if (episode === undefined || (episode.override === undefined && episode.tried.length === 0)) return undefined
			return {
				...(episode.override === undefined ? {} : { override: formatModelRoute(episode.override) }),
				tried: episode.tried.map(formatModelRoute),
			}
		},
	}
}
