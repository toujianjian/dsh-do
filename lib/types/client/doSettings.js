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
export const RETRY_DEFAULTS = {
    mode: 'normal',
    maxRetries: 5,
    initialDelayMs: 500,
    maxDelayMs: 10_000,
    jitterRatio: 0.1,
};
/** Largest delay a Node timer accepts without clamping. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;
/** The retry-policy settings namespace of the first-party DeepSeek adapter. */
export const DEEPSEEK_NS = 'llm-deepseek';
/** The retry-policy settings namespace of the multi-provider pi-ai adapter. */
export const PI_AI_NS = 'llm-pi-ai';
/** The namespace recording which provider/model new agents use. */
export const AGENT_DEFAULT_MODEL_NS = 'agent-default-model';
/** Read a plain-object property without trusting its shape. */
function field(value, key) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    return value[key];
}
/** Read a finite number, or undefined when absent or of another type. */
function numberOf(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
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
export function readRetryDraft(section, path) {
    let node = section;
    for (const segment of path)
        node = field(node, segment);
    const mode = field(node, 'mode');
    const backoff = field(node, 'backoff');
    return {
        mode: mode === 'always' ? 'always' : 'normal',
        maxRetries: numberOf(field(node, 'maxRetries')) ?? RETRY_DEFAULTS.maxRetries,
        initialDelayMs: numberOf(field(backoff, 'initialDelayMs')) ?? RETRY_DEFAULTS.initialDelayMs,
        maxDelayMs: numberOf(field(backoff, 'maxDelayMs')) ?? RETRY_DEFAULTS.maxDelayMs,
        jitterRatio: numberOf(field(backoff, 'jitterRatio')) ?? RETRY_DEFAULTS.jitterRatio,
    };
}
/** Whether the user layer carries an override at this path. */
export function isOverridden(userSection, path) {
    let node = userSection;
    for (const segment of path) {
        if (node === null || typeof node !== 'object' || Array.isArray(node))
            return false;
        const record = node;
        if (!Object.hasOwn(record, segment))
            return false;
        node = record[segment];
    }
    return node !== undefined;
}
/**
 * Validate a staged retry policy against the Host's own constraints.
 *
 * The Host re-validates everything; this exists so the page can refuse a draft
 * it knows is unacceptable instead of sending a write that will be rejected.
 *
 * @param draft - the staged values.
 * @returns the first problem, or undefined when the draft is acceptable.
 */
export function validateRetryDraft(draft) {
    const integer = (value, label, min, max) => {
        if (!Number.isSafeInteger(value))
            return `${label} 必须是整数。`;
        if (value < min)
            return `${label} 不能小于 ${min}。`;
        if (value > max)
            return `${label} 不能大于 ${max}。`;
        return undefined;
    };
    if (draft.mode === 'normal') {
        const problem = integer(draft.maxRetries, '最大重试次数', 0, 1000);
        if (problem !== undefined)
            return problem;
    }
    const initial = integer(draft.initialDelayMs, '初始退避时长（毫秒）', 0, MAX_TIMER_DELAY_MS);
    if (initial !== undefined)
        return initial;
    const max = integer(draft.maxDelayMs, '最大退避时长（毫秒）', 0, MAX_TIMER_DELAY_MS);
    if (max !== undefined)
        return max;
    if (draft.initialDelayMs > draft.maxDelayMs)
        return '初始退避时长不能大于最大退避时长。';
    if (!Number.isFinite(draft.jitterRatio))
        return '抖动比例必须是数字。';
    if (draft.jitterRatio < 0 || draft.jitterRatio > 1)
        return '抖动比例必须在 0 到 1 之间。';
    return undefined;
}
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
export function buildRetryPolicy(draft) {
    const backoff = {
        initialDelayMs: draft.initialDelayMs,
        maxDelayMs: draft.maxDelayMs,
        jitterRatio: draft.jitterRatio,
    };
    return draft.mode === 'always'
        ? { mode: 'always', backoff }
        : { mode: 'normal', maxRetries: draft.maxRetries, backoff };
}
/** The operations one save of `draft` writes at `target`. */
export function buildRetrySaveOps(target, draft) {
    return [{ op: 'set', path: target.path, value: buildRetryPolicy(draft) }];
}
/** The operations one reset of `target` writes, re-inheriting the composition layer. */
export function buildRetryResetOps(target) {
    return [{ op: 'unset', path: target.path }];
}
/** Index the served sections by namespace. */
export function indexSections(sections) {
    const map = new Map();
    for (const section of sections)
        map.set(section.ns, section);
    return map;
}
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
export function resolveRetryTargets(sections) {
    const targets = [];
    const deepseek = sections.get(DEEPSEEK_NS);
    if (deepseek !== undefined) {
        targets.push({ id: 'deepseek-official', namespace: DEEPSEEK_NS, label: 'DeepSeek 官方（llm-deepseek）', path: ['retryPolicy'] });
    }
    const providers = field(sections.get(PI_AI_NS)?.value, 'providers');
    if (providers !== null && typeof providers === 'object' && !Array.isArray(providers)) {
        for (const id of Object.keys(providers).sort()) {
            targets.push({ id, namespace: PI_AI_NS, label: `${id}（llm-pi-ai）`, path: ['providers', id, 'retryPolicy'] });
        }
    }
    return targets;
}
/** Read the deployment's selected provider/model. */
export function readActiveModel(section) {
    const provider = field(section, 'provider');
    const model = field(section, 'model');
    return {
        ...(typeof provider === 'string' && provider !== '' ? { provider } : {}),
        ...(typeof model === 'string' && model !== '' ? { model } : {}),
    };
}
/**
 * Choose the target the page opens on: the active provider's policy when the
 * deployment exposes one, otherwise the first served policy.
 *
 * @param targets - every served target.
 * @param active - the deployment's active model.
 * @returns the selected target, or undefined when none is served.
 */
export function selectRetryTarget(targets, active) {
    if (targets.length === 0)
        return undefined;
    const provider = active.provider;
    if (provider !== undefined) {
        const match = targets.find((target) => target.id === provider || (target.namespace === DEEPSEEK_NS && provider.startsWith('deepseek')));
        if (match !== undefined)
            return match;
    }
    return targets[0];
}
/** Default failure codes that trigger a model switch (mirrors the host schema). */
export const DEFAULT_FALLBACK_CODES = ['RATE_LIMIT', 'QUOTA', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'];
function stringList(value) {
    return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined;
}
/** Split a loose list: newlines, commas, semicolons (ASCII or full-width). */
export function splitList(text) {
    return text
        .split(/[\n,，;；]+/)
        .map((item) => item.trim())
        .filter(Boolean);
}
/** Read the loop-configuration form out of the resolved `dsh-do` section. */
export function readLoopDraft(section) {
    const detection = field(section, 'loopDetection');
    return {
        defaultMaxRounds: String(numberOf(field(section, 'defaultMaxRounds')) ?? 20),
        checkpointDir: typeof field(section, 'checkpointDir') === 'string' ? field(section, 'checkpointDir') : '',
        persist: field(section, 'persist') !== false,
        detectionEnabled: field(detection, 'enabled') !== false,
        repeatThreshold: String(numberOf(field(detection, 'repeatThreshold')) ?? 4),
        detectionCompact: field(detection, 'compact') !== false,
        maxInterventions: String(numberOf(field(detection, 'maxInterventions')) ?? 2),
        continueEnabled: field(field(section, 'autoContinue'), 'enabled') !== false,
        maxContinuations: String(numberOf(field(field(section, 'autoContinue'), 'maxContinuations')) ?? 3),
        continueOnlyWhileLooping: field(field(section, 'autoContinue'), 'onlyWhileLooping') !== false,
        fallbackEnabled: field(field(section, 'modelFallback'), 'enabled') === true,
        fallbackCandidates: (stringList(field(field(section, 'modelFallback'), 'candidates')) ?? []).join('\n'),
        fallbackCodes: (stringList(field(field(section, 'modelFallback'), 'triggerCodes')) ?? DEFAULT_FALLBACK_CODES).join(', '),
    };
}
/**
 * Validate a staged loop-configuration draft.
 * @param draft - the staged values.
 * @returns the first problem, or undefined when the draft is acceptable.
 */
export function validateLoopDraft(draft) {
    const rounds = Number(draft.defaultMaxRounds);
    if (!Number.isSafeInteger(rounds) || rounds < 1)
        return '默认最大轮次必须是大于 0 的整数。';
    const threshold = Number(draft.repeatThreshold);
    if (!Number.isSafeInteger(threshold) || threshold < 2)
        return '循环检测阈值必须是不小于 2 的整数。';
    const interventions = Number(draft.maxInterventions);
    if (!Number.isSafeInteger(interventions) || interventions < 1)
        return '最大干预次数必须是大于 0 的整数。';
    const continuations = Number(draft.maxContinuations);
    if (!Number.isSafeInteger(continuations) || continuations < 1)
        return '最大连续自动继续次数必须是大于 0 的整数。';
    for (const candidate of splitList(draft.fallbackCandidates)) {
        const slash = candidate.indexOf('/');
        if (slash <= 0 || slash === candidate.length - 1)
            return `候选模型「${candidate}」格式不对，应写作 provider/model。`;
    }
    if (draft.fallbackEnabled && splitList(draft.fallbackCandidates).length === 0)
        return '开启模型自动切换时至少要填一个候选模型。';
    return undefined;
}
/** The single top-level value one loop-configuration save writes. */
export function buildLoopSectionValue(draft) {
    return {
        defaultMaxRounds: Number(draft.defaultMaxRounds),
        checkpointDir: draft.checkpointDir.trim(),
        persist: draft.persist,
        loopDetection: {
            enabled: draft.detectionEnabled,
            repeatThreshold: Number(draft.repeatThreshold),
            compact: draft.detectionCompact,
            maxInterventions: Number(draft.maxInterventions),
        },
        autoContinue: {
            enabled: draft.continueEnabled,
            maxContinuations: Number(draft.maxContinuations),
            onlyWhileLooping: draft.continueOnlyWhileLooping,
        },
        modelFallback: {
            enabled: draft.fallbackEnabled,
            candidates: splitList(draft.fallbackCandidates),
            triggerCodes: splitList(draft.fallbackCodes).map((code) => code.toUpperCase()),
        },
    };
}
//# sourceMappingURL=doSettings.js.map