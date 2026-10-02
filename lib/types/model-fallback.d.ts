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
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ModelFallbackSettings } from './settings.js';
/** One `provider/model` route. */
export interface ModelRoute {
    readonly provider: string;
    readonly model: string;
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
export declare function parseModelRoute(text: string): ModelRoute | undefined;
/** Render a route back to its configured form. */
export declare function formatModelRoute(route: ModelRoute): string;
/** Whether two routes name the same model. */
export declare function sameRoute(a: ModelRoute | undefined, b: ModelRoute | undefined): boolean;
/**
 * Pick the next candidate after a failure.
 *
 * @param policy - the live fallback settings.
 * @param failing - the route that just failed (undefined when unknown).
 * @param tried - routes already used in this episode, including the primary.
 * @param code - the normalized failure code.
 * @returns the route to switch to, or a reason it will not switch.
 */
export declare function chooseFallback(policy: ModelFallbackSettings, failing: ModelRoute | undefined, tried: readonly ModelRoute[], code: string): {
    readonly kind: 'switch';
    readonly route: ModelRoute;
} | {
    readonly kind: 'keep';
    readonly reason: 'disabled' | 'code' | 'exhausted';
};
/** Read-only view of the fallback state, for status surfaces. */
export interface ModelFallbackView {
    readonly override?: string;
    readonly tried: readonly string[];
}
/** Handle returned by {@link installModelFallback}. */
export interface ModelFallbackHandle {
    /** Current fallback state of one agent, or undefined when none is active. */
    view(agent: Agent): ModelFallbackView | undefined;
}
/**
 * Install automatic model fallback.
 *
 * @param ctx - the plugin context.
 * @param policy - live reader for the fallback settings.
 * @returns a handle exposing per-agent state for status surfaces.
 */
export declare function installModelFallback(ctx: Context, policy: () => ModelFallbackSettings): ModelFallbackHandle;
