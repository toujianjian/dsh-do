import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AGENT_DEFAULT_MODEL_NS, buildLoopSectionValue, buildRetryResetOps, buildRetrySaveOps, indexSections, isOverridden, readActiveModel, readLoopDraft, readRetryDraft, resolveDoNamespace, resolveRetryTargets, selectRetryTarget, validateLoopDraft, validateRetryDraft, } from "./doSettings.js";
/** The bridge route this page reads and writes. */
const SETTINGS_PATH = '/dsh-do/settings';
/** Stable identity of one target across namespaces. */
function targetKey(target) {
    return `${target.namespace}::${target.id}`;
}
const CARD = {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    padding: '16px',
    border: '1px solid var(--dsw-border, rgba(127,127,127,0.28))',
    borderRadius: '10px',
};
const ROW = { display: 'flex', flexDirection: 'column', gap: '6px' };
const LABEL = { fontSize: '12px', opacity: 0.78 };
const HINT = { fontSize: '12px', opacity: 0.6, lineHeight: 1.5 };
const ERROR = { fontSize: '13px', color: 'var(--dsw-danger, #d64545)', lineHeight: 1.5 };
const OK = { fontSize: '13px', color: 'var(--dsw-success, #2f9e6b)', lineHeight: 1.5 };
const TITLE = { fontSize: '14px', fontWeight: 600 };
const ACTIONS = { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' };
const STACK = { display: 'flex', flexDirection: 'column', gap: '16px' };
/** A labelled text control. */
function TextField(props) {
    return (_jsxs("label", { style: ROW, children: [_jsx("span", { style: LABEL, children: props.label }), _jsx(Input, { value: props.value, onChange: (event) => props.onChange(event.target.value) }), props.hint === undefined ? null : _jsx("span", { style: HINT, children: props.hint })] }));
}
/** A labelled checkbox. */
function CheckField(props) {
    return (_jsxs("label", { style: { ...ROW, flexDirection: 'row', alignItems: 'center', gap: '8px' }, children: [_jsx("input", { type: "checkbox", checked: props.checked, onChange: (event) => props.onChange(event.target.checked) }), _jsx("span", { style: LABEL, children: props.label }), props.hint === undefined ? null : _jsx("span", { style: HINT, children: props.hint })] }));
}
/** A labelled select. */
function SelectField(props) {
    return (_jsxs("label", { style: ROW, children: [_jsx("span", { style: LABEL, children: props.label }), _jsx("select", { value: props.value, onChange: (event) => props.onChange(event.target.value), children: props.options.map((option) => (_jsx("option", { value: option.value, children: option.label }, option.value))) })] }));
}
/** Call the settings bridge and unwrap its answer. */
async function callBridge(init) {
    const response = await fetch(SETTINGS_PATH, {
        ...init,
        headers: { accept: 'application/json', ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }) },
    });
    let body;
    try {
        body = (await response.json());
    }
    catch {
        throw new Error(`HTTP ${response.status}`);
    }
    if (body.ok !== true)
        throw new Error(body.error ?? `HTTP ${response.status}`);
    return body;
}
/**
 * The settings page body.
 * @param props - the section owner share (the shell supplies `close`).
 */
export function DoSettingsPage(props) {
    const [sections, setSections] = useState(undefined);
    const [loadError, setLoadError] = useState(undefined);
    const [saveError, setSaveError] = useState(undefined);
    const [saved, setSaved] = useState(false);
    const [busy, setBusy] = useState(false);
    const [chosenKey, setChosenKey] = useState(undefined);
    const [loop, setLoop] = useState(undefined);
    const [retry, setRetry] = useState(undefined);
    /** The section revisions the drafts were read at, for write fencing. */
    const [revisions, setRevisions] = useState({});
    /** Namespace dsh-DO's own section was served under, resolved per response. */
    const [doNamespace, setDoNamespace] = useState(undefined);
    const byNs = useMemo(() => indexSections(sections ?? []), [sections]);
    const targets = useMemo(() => resolveRetryTargets(byNs), [byNs]);
    // The active provider's policy is the default selection, but an explicit
    // choice wins so switching providers is not undone by a refresh.
    const target = useMemo(() => {
        if (chosenKey !== undefined) {
            const chosen = targets.find((candidate) => targetKey(candidate) === chosenKey);
            if (chosen !== undefined)
                return chosen;
        }
        return selectRetryTarget(targets, readActiveModel(byNs.get(AGENT_DEFAULT_MODEL_NS)?.value));
    }, [targets, chosenKey, byNs]);
    /** Adopt a Host response: replace the sections and re-seed both forms. */
    const adopt = useCallback((next, selected) => {
        const map = indexSections(next);
        // The Host files dsh-DO's section under a namespace this build cannot know
        // in advance (the registered one on 0.1.x, the profile entry id on 0.2.x),
        // so it is resolved from the served sections on every response.
        const doNs = resolveDoNamespace(map);
        setSections(next);
        setDoNamespace(doNs);
        setLoop(readLoopDraft(doNs === undefined ? undefined : map.get(doNs)?.value));
        setRevisions({
            loop: doNs === undefined ? undefined : map.get(doNs)?.revision,
            ...(selected === undefined ? {} : { retry: map.get(selected.namespace)?.revision }),
        });
        setRetry(selected === undefined ? undefined : readRetryDraft(map.get(selected.namespace)?.value, selected.path));
    }, []);
    const load = useCallback(async () => {
        setLoadError(undefined);
        try {
            const body = await callBridge();
            const next = body.sections ?? [];
            const map = indexSections(next);
            adopt(next, selectRetryTarget(resolveRetryTargets(map), readActiveModel(map.get(AGENT_DEFAULT_MODEL_NS)?.value)));
        }
        catch (error) {
            setLoadError(error instanceof Error ? error.message : String(error));
        }
    }, [adopt]);
    useEffect(() => {
        void load();
    }, [load]);
    // Re-seed the retry form whenever the selection changes, so the controls
    // always show the policy of the provider named above them.
    useEffect(() => {
        if (target === undefined) {
            setRetry(undefined);
            return;
        }
        setRetry(readRetryDraft(byNs.get(target.namespace)?.value, target.path));
        setRevisions((current) => ({ ...current, retry: byNs.get(target.namespace)?.revision }));
    }, [target, byNs]);
    const problem = (loop === undefined ? undefined : validateLoopDraft(loop)) ?? (retry === undefined ? undefined : validateRetryDraft(retry));
    /** Apply one namespace's operations, then adopt whatever the Host accepted. */
    const write = useCallback(async (ns, ops, expectedRevision) => {
        const body = await callBridge({
            method: 'POST',
            body: JSON.stringify({ ns, ops, ...(expectedRevision === undefined ? {} : { expectedRevision }) }),
        });
        if (body.sections !== undefined)
            adopt(body.sections, target);
    }, [adopt, target]);
    const save = useCallback(async () => {
        if (loop === undefined || problem !== undefined || doNamespace === undefined)
            return;
        setBusy(true);
        setSaveError(undefined);
        setSaved(false);
        try {
            await write(doNamespace, [{ op: 'set', path: [], value: buildLoopSectionValue(loop) }], revisions.loop);
            if (retry !== undefined && target !== undefined)
                await write(target.namespace, buildRetrySaveOps(target, retry), revisions.retry);
            setSaved(true);
        }
        catch (error) {
            setSaveError(error instanceof Error ? error.message : String(error));
        }
        finally {
            setBusy(false);
        }
    }, [loop, retry, target, problem, revisions, write, doNamespace]);
    const resetRetry = useCallback(async () => {
        if (target === undefined)
            return;
        setBusy(true);
        setSaveError(undefined);
        setSaved(false);
        try {
            await write(target.namespace, buildRetryResetOps(target), revisions.retry);
        }
        catch (error) {
            setSaveError(error instanceof Error ? error.message : String(error));
        }
        finally {
            setBusy(false);
        }
    }, [target, revisions, write]);
    if (loadError !== undefined) {
        return (_jsxs("div", { style: CARD, children: [_jsx("span", { style: TITLE, children: "dsh-DO" }), _jsxs("span", { style: ERROR, children: ["\u8BFB\u53D6\u8BBE\u7F6E\u5931\u8D25\uFF1A", loadError] }), _jsx("div", { style: ACTIONS, children: _jsx(Button, { onClick: () => void load(), children: "\u91CD\u8BD5" }) })] }));
    }
    if (loop === undefined) {
        return (_jsx("div", { style: CARD, children: _jsx("span", { style: HINT, children: "\u6B63\u5728\u8BFB\u53D6\u8BBE\u7F6E\u2026" }) }));
    }
    const retryOverridden = target !== undefined && isOverridden(byNs.get(target.namespace)?.user, target.path);
    return (_jsxs("div", { style: STACK, children: [_jsxs("div", { style: CARD, children: [_jsx("span", { style: TITLE, children: "\u5FAA\u73AF\uFF08dsh-DO\uFF09" }), _jsx(TextField, { label: "\u9ED8\u8BA4\u6700\u5927\u8F6E\u6B21", value: loop.defaultMaxRounds, hint: "\u6A21\u578B\u672A\u6307\u5B9A max_rounds \u65F6\uFF0C\u4E00\u6B21\u5FAA\u73AF\u6700\u591A\u81EA\u52A8\u7EED\u8DD1\u591A\u5C11\u8F6E\u3002", onChange: (next) => setLoop({ ...loop, defaultMaxRounds: next }) }), _jsx(TextField, { label: "\u68C0\u67E5\u70B9\u76EE\u5F55", value: loop.checkpointDir, hint: "\u7559\u7A7A\u5219\u4F7F\u7528 $DSH_HOME/loops\u3002\u6539\u52A8\u53EA\u5F71\u54CD\u4E4B\u540E\u5199\u5165\u7684\u68C0\u67E5\u70B9\uFF0C\u4E0D\u4F1A\u8FC1\u79FB\u6216\u590D\u6D3B\u5DF2\u6709\u5FAA\u73AF\u3002", onChange: (next) => setLoop({ ...loop, checkpointDir: next }) }), _jsx(CheckField, { label: "\u6301\u4E45\u5316\u5FAA\u73AF\u72B6\u6001", checked: loop.persist, hint: "\u5173\u95ED\u540E\u5FAA\u73AF\u53EA\u5B58\u5728\u4E8E\u5185\u5B58\uFF0C\u8FDB\u7A0B\u91CD\u542F\u4E0D\u4F1A\u6062\u590D\u3002", onChange: (next) => setLoop({ ...loop, persist: next }) })] }), _jsxs("div", { style: CARD, children: [_jsx("span", { style: TITLE, children: "\u6A21\u578B\u5FAA\u73AF\u68C0\u6D4B" }), _jsx("span", { style: HINT, children: "\u68C0\u6D4B\u5230\u6A21\u578B\u8FDE\u7EED\u91CD\u590D\u540C\u4E00\u4E2A\u5DE5\u5177\u8C03\u7528\u65F6\uFF0C\u81EA\u52A8\u4E2D\u65AD\u8BE5\u8F6E\u3001\u538B\u7F29\u5386\u53F2\u5E76\u91CD\u53D1\u8BF7\u6C42\u3002\u82E5\u8BE5\u4F1A\u8BDD\u6B63\u7531\u5FAA\u73AF\u6216\u76EE\u6807\u9A71\u52A8\u63A5\u7BA1\uFF0C\u5219\u53EA\u6295\u9012\u7EA0\u6B63\u63D0\u793A\u800C\u4E0D\u4E2D\u65AD\uFF0C\u4EE5\u514D\u505C\u6389\u4F60\u6B63\u5728\u8DD1\u7684\u5FAA\u73AF\u3002" }), _jsx(CheckField, { label: "\u542F\u7528\u68C0\u6D4B", checked: loop.detectionEnabled, onChange: (next) => setLoop({ ...loop, detectionEnabled: next }) }), _jsx(TextField, { label: "\u91CD\u590D\u9608\u503C\uFF08\u8FDE\u7EED\u76F8\u540C\u8C03\u7528\u6B21\u6570\uFF09", value: loop.repeatThreshold, hint: "\u4E0D\u5C0F\u4E8E 2\u3002", onChange: (next) => setLoop({ ...loop, repeatThreshold: next }) }), _jsx(CheckField, { label: "\u6062\u590D\u524D\u538B\u7F29\u5386\u53F2", checked: loop.detectionCompact, hint: "\u5173\u95ED\u540E\u53EA\u4E2D\u65AD\u5E76\u91CD\u53D1\uFF0C\u4E0D\u505A\u538B\u7F29\u3002", onChange: (next) => setLoop({ ...loop, detectionCompact: next }) }), _jsx(TextField, { label: "\u5355\u8F6E\u6700\u5927\u5E72\u9884\u6B21\u6570", value: loop.maxInterventions, hint: "\u8FBE\u5230\u4E0A\u9650\u540E\u53EA\u6295\u9012\u7EA0\u6B63\u63D0\u793A\uFF0C\u907F\u514D\u6062\u590D\u6D41\u7A0B\u81EA\u5DF1\u53D8\u6210\u5FAA\u73AF\u3002", onChange: (next) => setLoop({ ...loop, maxInterventions: next }) })] }), _jsxs("div", { style: CARD, children: [_jsx("span", { style: TITLE, children: "\u8F93\u51FA\u4E0A\u9650\u81EA\u52A8\u7EE7\u7EED" }), _jsx("span", { style: HINT, children: "\u6A21\u578B\u56DE\u7B54\u88AB\u8F93\u51FA token \u4E0A\u9650\u622A\u65AD\uFF08max-tokens\uFF09\u65F6\uFF0C\u81EA\u52A8\u53D1\u4E00\u8F6E\u300C\u4ECE\u65AD\u70B9\u63A5\u7740\u5199\u300D\uFF0C\u4E0D\u518D\u505C\u4E0B\u7B49\u4F60\u3002" }), _jsx(CheckField, { label: "\u542F\u7528\u81EA\u52A8\u7EE7\u7EED", checked: loop.continueEnabled, onChange: (next) => setLoop({ ...loop, continueEnabled: next }) }), _jsx(TextField, { label: "\u6700\u5927\u8FDE\u7EED\u7EE7\u7EED\u6B21\u6570", value: loop.maxContinuations, hint: "\u540C\u4E00\u6BB5\u56DE\u7B54\u8FDE\u7EED\u88AB\u622A\u65AD\u8D85\u8FC7\u8FD9\u4E2A\u6B21\u6570\u5C31\u505C\u4E0B\u5E76\u63D0\u793A\uFF0C\u9632\u6B62\u65E0\u9650\u7EED\u5199\u3002", onChange: (next) => setLoop({ ...loop, maxContinuations: next }) }), _jsx(CheckField, { label: "\u53EA\u5728\u5FAA\u73AF\u8FD0\u884C\u4E2D\u81EA\u52A8\u7EE7\u7EED", checked: loop.continueOnlyWhileLooping, hint: "\u5173\u95ED\u540E\u666E\u901A\u5BF9\u8BDD\u88AB\u622A\u65AD\u4E5F\u4F1A\u81EA\u52A8\u7EE7\u7EED\u3002", onChange: (next) => setLoop({ ...loop, continueOnlyWhileLooping: next }) })] }), _jsxs("div", { style: CARD, children: [_jsx("span", { style: TITLE, children: "\u6A21\u578B\u81EA\u52A8\u5207\u6362" }), _jsx("span", { style: HINT, children: "\u5F53\u524D\u6A21\u578B\u62A5 429 \u7B49\u9519\u8BEF\u3001\u4E14\u8BE5\u63D0\u4F9B\u65B9\u7684\u91CD\u8BD5\u7B56\u7565\u5DF2\u7ECF\u653E\u5F03\u540E\uFF0C\u6309\u987A\u5E8F\u6362\u4E0B\u4E00\u4E2A\u5019\u9009\u6A21\u578B\u91CD\u53D1\u540C\u4E00\u8BF7\u6C42\u3002\u4E0B\u4E00\u6761\u4F60\u4EB2\u81EA\u53D1\u7684\u6D88\u606F\u4F1A\u5148\u56DE\u5230\u4F60\u9009\u7684\u6A21\u578B\u3002\u6240\u6709\u5019\u9009\u90FD\u5931\u8D25\u65F6\u6309\u539F\u6837\u62A5\u9519\u3002" }), _jsx(CheckField, { label: "\u542F\u7528\u81EA\u52A8\u5207\u6362", checked: loop.fallbackEnabled, onChange: (next) => setLoop({ ...loop, fallbackEnabled: next }) }), _jsxs("label", { style: ROW, children: [_jsx("span", { style: LABEL, children: "\u5019\u9009\u6A21\u578B\uFF08\u6309\u987A\u5E8F\uFF0C\u6BCF\u884C\u4E00\u4E2A provider/model\uFF09" }), _jsx("textarea", { value: loop.fallbackCandidates, rows: 4, style: { font: 'inherit', padding: '6px 8px', borderRadius: '6px' }, onChange: (event) => setLoop({ ...loop, fallbackCandidates: event.target.value }) })] }), _jsx(TextField, { label: "\u89E6\u53D1\u5207\u6362\u7684\u9519\u8BEF\u7801", value: loop.fallbackCodes, hint: "\u9017\u53F7\u5206\u9694\u3002\u9ED8\u8BA4 RATE_LIMIT, QUOTA, SERVER, TIMEOUT, TRANSPORT, EMPTY_RESPONSE\u3002", onChange: (next) => setLoop({ ...loop, fallbackCodes: next }) })] }), _jsxs("div", { style: CARD, children: [_jsx("span", { style: TITLE, children: "\u65AD\u8FDE\u91CD\u8BD5\u7B56\u7565" }), target === undefined || retry === undefined ? (_jsx("span", { style: HINT, children: "\u5F53\u524D\u90E8\u7F72\u6CA1\u6709\u66B4\u9732\u53EF\u7F16\u8F91\u7684\u91CD\u8BD5\u7B56\u7565\u547D\u540D\u7A7A\u95F4\u3002" })) : (_jsxs(_Fragment, { children: [_jsx(SelectField, { label: "\u63D0\u4F9B\u65B9", value: targetKey(target), options: targets.map((candidate) => ({ value: targetKey(candidate), label: candidate.label })), onChange: (next) => setChosenKey(next) }), _jsx(SelectField, { label: "\u6A21\u5F0F", value: retry.mode, options: [
                                    { value: 'normal', label: 'normal（只重试可重试错误码）' },
                                    { value: 'always', label: 'always（任何失败都重试）' },
                                ], onChange: (next) => setRetry({ ...retry, mode: next }) }), retry.mode === 'normal' ? (_jsx(TextField, { label: "\u6700\u5927\u91CD\u8BD5\u6B21\u6570", value: String(retry.maxRetries), hint: "DSH \u5185\u7F6E\u9ED8\u8BA4 5\u3002", onChange: (next) => setRetry({ ...retry, maxRetries: Number(next) }) })) : null, _jsx(TextField, { label: "\u521D\u59CB\u9000\u907F\u65F6\u957F\uFF08\u6BEB\u79D2\uFF09", value: String(retry.initialDelayMs), hint: "DSH \u5185\u7F6E\u9ED8\u8BA4 500\u3002", onChange: (next) => setRetry({ ...retry, initialDelayMs: Number(next) }) }), _jsx(TextField, { label: "\u6700\u5927\u9000\u907F\u65F6\u957F\uFF08\u6BEB\u79D2\uFF09", value: String(retry.maxDelayMs), hint: "DSH \u5185\u7F6E\u9ED8\u8BA4 10000\u3002", onChange: (next) => setRetry({ ...retry, maxDelayMs: Number(next) }) }), _jsx(TextField, { label: "\u6296\u52A8\u6BD4\u4F8B\uFF080-1\uFF09", value: String(retry.jitterRatio), hint: "DSH \u5185\u7F6E\u9ED8\u8BA4 0.1\u3002", onChange: (next) => setRetry({ ...retry, jitterRatio: Number(next) }) }), _jsxs("span", { style: HINT, children: ["\u53EF\u91CD\u8BD5\u9519\u8BEF\u7801\u6CBF\u7528\u9002\u914D\u5668\u5185\u7F6E\u5217\u8868\uFF08RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT / EMPTY_RESPONSE\uFF09\uFF0C\u4E0D\u5728\u6B64\u5904\u8986\u5199\u3002", retryOverridden ? ' 该提供方已有用户覆写。' : ' 当前继承组合默认值。'] }), _jsx("div", { style: ACTIONS, children: _jsx(Button, { variant: "outline", disabled: busy || !retryOverridden, onClick: () => void resetRetry(), children: "\u91CD\u7F6E\u4E3A\u7EC4\u5408\u9ED8\u8BA4" }) })] }))] }), problem === undefined ? null : _jsx("span", { style: ERROR, children: problem }), saveError === undefined ? null : _jsxs("span", { style: ERROR, children: ["\u4FDD\u5B58\u5931\u8D25\uFF1A", saveError] }), saved && saveError === undefined ? _jsx("span", { style: OK, children: "\u5DF2\u4FDD\u5B58\u3002" }) : null, _jsxs("div", { style: ACTIONS, children: [_jsx(Button, { disabled: busy || problem !== undefined, onClick: () => void save(), children: busy ? '保存中…' : '保存' }), _jsx(Button, { variant: "outline", disabled: busy, onClick: () => void load(), children: "\u653E\u5F03\u4FEE\u6539\u5E76\u91CD\u65B0\u8BFB\u53D6" }), _jsx(Button, { variant: "outline", onClick: props.close, children: "\u5173\u95ED" })] })] }));
}
//# sourceMappingURL=DoSettingsPage.js.map