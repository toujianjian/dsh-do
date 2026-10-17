/** This plugin's producer-owned source kind. */
export declare const DO_SOURCE_KIND = "dsh-do";
/**
 * Source of one dsh-do notice: a one-off account of something that just
 * happened, which supersedes nothing.
 */
export interface DoMessageSource {
    readonly kind: 'dsh-do';
    /** `notice` form, the declared shape for a one-off account. */
    readonly form: 'notice';
    /** One-line account, shown without expanding the transcript row. */
    readonly summary: string;
}
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'dsh-do': DoMessageSource;
    }
}
/**
 * Build the source for one model-visible notice.
 *
 * @param summary - one-line account of what happened, of any length.
 * @returns a source carrying this plugin's own kind.
 */
export declare function doNoticeSource(summary: string): DoMessageSource;
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
export declare function isDoSource(source: unknown): boolean;
