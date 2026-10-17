/**
 * The producer-owned source this plugin stamps on every message it injects.
 *
 * DSH 0.2.0 (session format v4) retired the catch-all `{ kind: 'plugin', plugin }`
 * wrapper. The vocabulary is now explicit — "each producer declares its own
 * `kind` in its own module; there is no shared catch-all `plugin` kind"
 * (`@deepseek-ai/dsh-llm` `MessageSourceMap`) — and a v4 session log refuses the
 * retired wrapper *when the row is encoded*, with `format v4 message requires a
 * producer-owned source kind` (`@deepseek-ai/dsh-session-format-v3-to-v4`).
 *
 * The refusal happens while the notice is being spliced into the inbox, so the
 * turn that carried it fails and the announcement dies with it. On this plugin
 * that silently disabled every notice it owns: the loop pause announcement, the
 * output-limit auto-continuation, the repeated-call correction, and the
 * `loop_done`/`loop_cancel` wrap-up context. An armed loop therefore stopped
 * after its first round — the round prompt itself was never affected, because it
 * already carried its own `loop` kind.
 *
 * Stamping this plugin's own kind is accepted by both runtimes: 0.1.x admits any
 * kind (its map is merge-extensible), and 0.2.x requires exactly this.
 *
 * @module dsh-do/source
 */
import { boundContextSummary } from '@deepseek-ai/dsh-llm';
/** This plugin's producer-owned source kind. */
export const DO_SOURCE_KIND = 'dsh-do';
/**
 * Build the source for one model-visible notice.
 *
 * @param summary - one-line account of what happened, of any length.
 * @returns a source carrying this plugin's own kind.
 */
export function doNoticeSource(summary) {
    return { kind: DO_SOURCE_KIND, form: 'notice', summary: boundContextSummary(summary) };
}
/**
 * Whether a source was produced by this plugin.
 *
 * `plugin:dsh-do` is what DSH's own v3→v4 migration writes when it lifts a
 * released plugin wrapper, so a source read back out of an older log is
 * recognised alongside the live kind.
 *
 * @param source - any message source.
 * @returns true when this plugin produced it.
 */
export function isDoSource(source) {
    if (typeof source !== 'object' || source === null)
        return false;
    const kind = source.kind;
    return kind === DO_SOURCE_KIND || kind === `plugin:${DO_SOURCE_KIND}`;
}
//# sourceMappingURL=source.js.map