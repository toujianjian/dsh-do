/**
 * Pure logic for the dsh-DO settings page: what the page reads from the
 * resolved settings sections, how a staged retry policy is validated, and which
 * write operations a save produces.
 *
 * Kept free of React and Cordis so the decisions the page makes are testable
 * under `node --test`, mirroring the `github.ts` / `GitHubSearchButton.tsx`
 * split this plugin already uses.
 *
 * @module dsh-do/client/do-settings
 */
/** DeepSeek Harness's built-in retry defaults, mirrored from `dsh-llm`. */
export declare const RETRY_DEFAULTS: {
    readonly mode: "normal";
    readonly maxRetries: 5;
    readonly initialDelayMs: 500;
    readonly maxDelayMs: 10000;
    readonly jitterRatio: 0.1;
};
/** Largest delay a Node timer accepts without clamping. */
export declare const MAX_TIMER_DELAY_MS = 2147483647;
/** Retry-policy modes the Host accepts. */
export type RetryMode = 'normal' | 'always';
/** The editable shape of one provider's retry policy. */
export interface RetryDraft {
    readonly mode: RetryMode;
    readonly maxRetries: number;
    readonly initialDelayMs: number;
    readonly maxDelayMs: number;
    readonly jitterRatio: number;
}
/** One editable retry policy, and where it lives in the settings document. */
export interface RetryTarget {
    /** Stable key used by the selector. */
    readonly id: string;
    /** Settings namespace owning the policy. */
    readonly namespace: string;
    /** Human label for the selector. */
    readonly label: string;
    /** Path from the namespace root to the `retryPolicy` object. */
    readonly path: readonly string[];
}
/** One write operation the Host applies. */
export interface SettingsOperation {
    readonly op: 'set' | 'unset';
    readonly path: readonly string[];
    readonly value?: unknown;
}
/** The retry-policy settings namespace of the first-party DeepSeek adapter. */
export declare const DEEPSEEK_NS = "llm-deepseek";
/** The retry-policy settings namespace of the multi-provider pi-ai adapter. */
export declare const PI_AI_NS = "llm-pi-ai";
/** The namespace recording which provider/model new agents use. */
export declare const AGENT_DEFAULT_MODEL_NS = "agent-default-model";
/**
 * Read one provider's retry policy out of a resolved settings section.
 *
 * Absent fields fall back to the Host's built-in defaults, so the page shows
 * what the adapter would actually use rather than an empty form.
 *
 * @param section - the resolved section, or undefined before the first read.
 * @param path - path from the section root to the `retryPolicy` object.
 * @returns the effective policy.
 */
export declare function readRetryDraft(section: unknown, path: readonly string[]): RetryDraft;
/** Whether the user layer carries an override at this path. */
export declare function isOverridden(userSection: unknown, path: readonly string[]): boolean;
/**
 * Validate a staged retry policy against the Host's own constraints.
 *
 * The Host re-validates everything; this exists so the page can refuse a draft
 * it knows is unacceptable instead of sending a write that will be rejected.
 *
 * @param draft - the staged values.
 * @returns the first problem, or undefined when the draft is acceptable.
 */
export declare function validateRetryDraft(draft: RetryDraft): string | undefined;
/**
 * Build the complete `retryPolicy` object one save writes.
 *
 * The Host's schema requires `mode` and validates the object as a whole, so a
 * partial write that omitted it would be refused. `retryableCodes` is
 * deliberately omitted: leaving it absent keeps the adapter's built-in code
 * list, which is what a user editing delays expects.
 *
 * @param draft - the validated staged values.
 * @returns the JSON value to store at the target path.
 */
export declare function buildRetryPolicy(draft: RetryDraft): Record<string, unknown>;
/** The operations one save of `draft` writes at `target`. */
export declare function buildRetrySaveOps(target: RetryTarget, draft: RetryDraft): SettingsOperation[];
/** The operations one reset of `target` writes, re-inheriting the composition layer. */
export declare function buildRetryResetOps(target: RetryTarget): SettingsOperation[];
/** One namespace as the Host bridge serves it. */
export interface SettingsSectionView {
    readonly ns: string;
    readonly value: unknown;
    readonly user?: unknown;
    readonly revision: number;
}
/** Index the served sections by namespace. */
export declare function indexSections(sections: readonly SettingsSectionView[]): Map<string, SettingsSectionView>;
/**
 * Discover every retry policy the deployment actually exposes.
 *
 * A namespace only yields a target when the Host serves it, so a deployment
 * composing one adapter shows one policy rather than an inert form for the
 * other.
 *
 * @param sections - served sections indexed by namespace.
 * @returns the targets, in a stable order.
 */
export declare function resolveRetryTargets(sections: ReadonlyMap<string, SettingsSectionView>): RetryTarget[];
/** The provider/model the deployment selects for new agents. */
export interface ActiveModel {
    readonly provider?: string;
    readonly model?: string;
}
/** Read the deployment's selected provider/model. */
export declare function readActiveModel(section: unknown): ActiveModel;
/**
 * Choose the target the page opens on: the active provider's policy when the
 * deployment exposes one, otherwise the first served policy.
 *
 * @param targets - every served target.
 * @param active - the deployment's active model.
 * @returns the selected target, or undefined when none is served.
 */
export declare function selectRetryTarget(targets: readonly RetryTarget[], active: ActiveModel): RetryTarget | undefined;
/** One staged text field of the loop-configuration form. */
export interface LoopDraft {
    readonly defaultMaxRounds: string;
    readonly checkpointDir: string;
    readonly persist: boolean;
    readonly detectionEnabled: boolean;
    readonly repeatThreshold: string;
    readonly detectionCompact: boolean;
    readonly maxInterventions: string;
    readonly continueEnabled: boolean;
    readonly maxContinuations: string;
    readonly continueOnlyWhileLooping: boolean;
    readonly fallbackEnabled: boolean;
    /** One `provider/model` per line, in order. */
    readonly fallbackCandidates: string;
    /** Comma-separated failure codes. */
    readonly fallbackCodes: string;
}
/** Default failure codes that trigger a model switch (mirrors the host schema). */
export declare const DEFAULT_FALLBACK_CODES: string[];
/** Split a loose list: newlines, commas, semicolons (ASCII or full-width). */
export declare function splitList(text: string): string[];
/** Read the loop-configuration form out of the resolved `dsh-do` section. */
export declare function readLoopDraft(section: unknown): LoopDraft;
/**
 * Validate a staged loop-configuration draft.
 * @param draft - the staged values.
 * @returns the first problem, or undefined when the draft is acceptable.
 */
export declare function validateLoopDraft(draft: LoopDraft): string | undefined;
/** The single top-level value one loop-configuration save writes. */
export declare function buildLoopSectionValue(draft: LoopDraft): Record<string, unknown>;
//# sourceMappingURL=doSettings.d.ts.map