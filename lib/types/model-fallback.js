/**
 * Parse one candidate written as `provider/model`.
 *
 * Only the FIRST slash separates the two: model ids such as
 * `anthropic/claude-sonnet` (an OpenRouter-style id) keep their own slashes.
 *
 * @param text - the configured candidate.
 * @returns the route, or undefined for a malformed entry.
 */
export function parseModelRoute(text) {
    const trimmed = text.trim();
    const slash = trimmed.indexOf('/');
    if (slash <= 0 || slash === trimmed.length - 1)
        return undefined;
    return { provider: trimmed.slice(0, slash).trim(), model: trimmed.slice(slash + 1).trim() };
}
/** Render a route back to its configured form. */
export function formatModelRoute(route) {
    return `${route.provider}/${route.model}`;
}
/** Whether two routes name the same model. */
export function sameRoute(a, b) {
    return a !== undefined && b !== undefined && a.provider === b.provider && a.model === b.model;
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
export function chooseFallback(policy, failing, tried, code) {
    if (!policy.enabled)
        return { kind: 'keep', reason: 'disabled' };
    if (!policy.triggerCodes.includes(code))
        return { kind: 'keep', reason: 'code' };
    for (const text of policy.candidates) {
        const route = parseModelRoute(text);
        if (route === undefined)
            continue;
        if (sameRoute(route, failing))
            continue;
        if (tried.some((used) => sameRoute(used, route)))
            continue;
        return { kind: 'switch', route };
    }
    return { kind: 'keep', reason: 'exhausted' };
}
/**
 * Install automatic model fallback.
 *
 * @param ctx - the plugin context.
 * @param policy - live reader for the fallback settings.
 * @returns a handle exposing per-agent state for status surfaces.
 */
export function installModelFallback(ctx, policy) {
    const episodes = new WeakMap();
    const episodeFor = (agent) => {
        let episode = episodes.get(agent);
        if (episode === undefined) {
            episode = { tried: [] };
            episodes.set(agent, episode);
        }
        return episode;
    };
    // Outermost, so the session's own model selection resolves first and this
    // only replaces the route when a switch is active.
    ctx.on('agent/request', async ({ agent }, next) => {
        const resolved = await next();
        const episode = episodeFor(agent);
        const override = policy().enabled ? episode.override : undefined;
        if (override === undefined) {
            episode.last = { provider: resolved.provider, model: resolved.model };
            return resolved;
        }
        const { reasoningEffort: _inherited, ...rest } = resolved;
        episode.last = override;
        return { ...rest, provider: override.provider, model: override.model };
    }, { prepend: true });
    ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
        // The provider's retry policy runs first; only its give-up reaches here.
        const downstream = await next();
        if (downstream?.kind === 'retry' || signal.aborted)
            return downstream;
        const episode = episodeFor(agent);
        const failing = episode.last;
        if (failing !== undefined && !episode.tried.some((used) => sameRoute(used, failing)))
            episode.tried.push(failing);
        const choice = chooseFallback(policy(), failing, episode.tried, failure.code);
        if (choice.kind === 'keep') {
            if (choice.reason === 'exhausted') {
                ctx.logger.warn(`dsh-do: every fallback model failed for agent "${agent.id}" (${failure.code}); the error stands`);
            }
            return downstream;
        }
        episode.override = choice.route;
        episode.tried.push(choice.route);
        ctx.logger.info(`dsh-do: ${failing === undefined ? 'model' : formatModelRoute(failing)} failed with ${failure.code}; switching agent "${agent.id}" to ${formatModelRoute(choice.route)}`);
        return { kind: 'retry' };
    }, { prepend: true });
    // A human message is a fresh decision by the user: try their own model again.
    ctx.on('session/event', (session, event) => {
        if (event.type !== 'user/message')
            return;
        // Only a real human message (`kind: 'user'`) resets; loop rounds, plugin
        // notices and auto-continue turns keep the switched model.
        const source = event.data.source;
        if (source?.kind !== 'user')
            return;
        const agent = ctx.agents.get(session.id);
        if (agent !== undefined)
            episodes.delete(agent);
    });
    return {
        view(agent) {
            const episode = episodes.get(agent);
            if (episode === undefined || (episode.override === undefined && episode.tried.length === 0))
                return undefined;
            return {
                ...(episode.override === undefined ? {} : { override: formatModelRoute(episode.override) }),
                tried: episode.tried.map(formatModelRoute),
            };
        },
    };
}
//# sourceMappingURL=model-fallback.js.map