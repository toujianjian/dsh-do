import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm';
/** The source stamped on every message this module injects. */
const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'dsh-do' };
/** Longest quoted argument preview in a model-visible notice. */
const ARGUMENTS_PREVIEW_CHARS = 500;
/**
 * Deep key-sort of a parsed-JSON value so two argument objects that differ only
 * in property order canonicalize identically. Arguments reach this module as
 * the loop's parsed output, so JSON's value domain is the whole input domain.
 */
export function sortJsonValue(value) {
    if (Array.isArray(value))
        return value.map(sortJsonValue);
    if (value !== null && typeof value === 'object') {
        const record = value;
        const sorted = {};
        for (const key of Object.keys(record).sort())
            sorted[key] = sortJsonValue(record[key]);
        return sorted;
    }
    return value;
}
/** Canonical string form of a call's arguments: deep key-sort, then stringify. */
export function canonicalizeArguments(value) {
    const encoded = JSON.stringify(sortJsonValue(value));
    // `undefined` arguments and a bare `undefined` value both encode to
    // `undefined`; one stable token keeps the chain key well-formed.
    return encoded === undefined ? 'null' : encoded;
}
/** Advance one agent's run for a settled call. */
export function advanceRepeatChain(previous, name, canonical) {
    const key = JSON.stringify([name, canonical]);
    return { key, count: previous !== undefined && previous.key === key ? previous.count + 1 : 1 };
}
/**
 * Decide what one settled call means for the agent's session.
 *
 * @param chain - the run after {@link advanceRepeatChain}.
 * @param policy - the live detection settings.
 * @param driverArmed - whether an autonomous driver owns this session's continuation.
 * @param interventions - interruptions already performed for this session.
 * @returns the verdict.
 */
export function decideLoopVerdict(chain, policy, driverArmed, interventions) {
    if (!policy.enabled || chain.count < policy.repeatThreshold)
        return { kind: 'continue' };
    const name = JSON.parse(chain.key)[0];
    if (driverArmed)
        return { kind: 'nudge', count: chain.count, name };
    if (interventions >= policy.maxInterventions)
        return { kind: 'nudge', count: chain.count, name };
    return { kind: 'intervene', count: chain.count, name };
}
/** Head-truncate canonical arguments for quoting in a model-visible notice. */
export function previewArguments(canonical, cap = ARGUMENTS_PREVIEW_CHARS) {
    return canonical.length <= cap ? canonical : `${canonical.slice(0, cap)}… (+${canonical.length - cap} more chars)`;
}
/** The corrective text delivered when the detector cannot interrupt. */
export function renderLoopNotice(name, count, canonical) {
    return [
        {
            type: 'text',
            text: `Repeated tool call detected:
- tool: ${name}
- consecutive_calls: ${count}
- arguments: ${previewArguments(canonical)}
The repeated calls are not making progress. Do not call this tool with these exact arguments again. Inspect the latest result and choose a different action, different arguments, or finish the task if enough evidence has been gathered.`,
        },
    ];
}
/** The instruction that re-sends the interrupted request over compacted history. */
export function renderRecoveryPrompt(name, count, compacted) {
    const opening = compacted
        ? 'This session was interrupted because you repeated one tool call without making progress, and its history has just been compacted.'
        : 'This session was interrupted because you repeated one tool call without making progress.';
    // The body must not claim a compaction that did not happen, so the
    // continuation sentence follows the same switch as the opening one.
    const continuation = compacted ? 'Continue the task from the compacted state.' : 'Continue the task.';
    return [
        {
            type: 'text',
            text: `<loop_interrupted>
${opening}

- tool: ${name}
- consecutive_calls: ${count}

${continuation} The repeated call is not a valid next action: re-read the current workspace and the latest results, then either take a different action, use different arguments, or finish and report the outcome. If the task genuinely cannot proceed, say what blocks it instead of retrying the same call.
</loop_interrupted>`,
        },
    ];
}
/**
 * Install model-loop detection and recovery.
 *
 * The listener rides a compaction-gated child context: the recovery this module
 * promises is stop-then-compact-then-resend, so a deployment without a
 * compaction service keeps its existing behavior instead of getting a partial
 * one.
 *
 * @param ctx - the plugin context.
 * @param options - live policy and the driver-ownership probe.
 */
export function installLoopDetection(ctx, options) {
    ctx.inject(['compaction'], (child) => {
        const chains = new Map();
        const budgets = new Map();
        /** Cancellation owned by this installation, aborted on teardown. */
        const controller = new AbortController();
        function budgetFor(agent) {
            let budget = budgets.get(agent);
            if (budget === undefined) {
                budget = { interventions: 0, inFlight: false };
                budgets.set(agent, budget);
            }
            return budget;
        }
        /**
         * Interrupt one looping agent, compact its history, and re-send the
         * request. Runs detached from the tool pipeline so the settling call
         * returns normally first.
         */
        async function recover(agent, name, count, budget) {
            const policy = options.policy();
            try {
                // Let the settled call finish publishing before the turn is aborted.
                await Promise.resolve();
                agent.cancel({ kind: 'hook', reason: 'dsh-do: repeated tool call' });
                await agent.whenIdle();
                if (controller.signal.aborted)
                    return;
                let compacted = false;
                if (policy.compact) {
                    try {
                        const result = await child.compaction.compactNow(agent, controller.signal);
                        compacted = result !== null;
                    }
                    catch (error) {
                        // A compaction that lost the idle phase to another wake, or found
                        // no useful range, must not suppress the re-sent request.
                        child.logger.warn(`dsh-do: loop recovery could not compact: ${String(error)}`);
                    }
                }
                if (controller.signal.aborted)
                    return;
                budget.interventions += 1;
                agent.followup(createUserMessage({
                    content: renderRecoveryPrompt(name, count, compacted),
                    source: {
                        ...PLUGIN_SOURCE,
                        form: 'notice',
                        summary: boundContextSummary(`dsh-do loop recovery: ${name} × ${count}`),
                    },
                }));
            }
            catch (error) {
                child.logger.warn(`dsh-do: loop recovery failed: ${String(error)}`);
            }
            finally {
                budget.inFlight = false;
            }
        }
        child.effect(() => child.on('tools/post-execute', async (exec, _result, next) => {
            const downstream = await next();
            const agent = exec.agent;
            if (agent === undefined)
                return downstream;
            const chain = advanceRepeatChain(chains.get(agent), exec.name, canonicalizeArguments(exec.arguments));
            chains.set(agent, chain);
            const budget = budgetFor(agent);
            const verdict = decideLoopVerdict(chain, options.policy(), options.driverArmed(agent), budget.interventions);
            if (verdict.kind === 'continue')
                return downstream;
            const canonical = JSON.parse(chain.key)[1];
            if (verdict.kind === 'intervene' && !budget.inFlight) {
                budget.inFlight = true;
                void recover(agent, verdict.name, verdict.count, budget);
            }
            const notice = createUserMessage({
                content: renderLoopNotice(verdict.name, verdict.count, canonical),
                source: { ...PLUGIN_SOURCE, form: 'notice', summary: boundContextSummary(`dsh-do repeated call: ${verdict.name} × ${verdict.count}`) },
            });
            return { ...downstream, additionalContexts: [notice, ...(downstream.additionalContexts ?? [])] };
        }), 'dsh-do.loop-detection()');
        // A real human message ends the episode: the model has new information,
        // so a later repeat is a fresh loop with a fresh interruption budget.
        child.effect(() => child.on('agent/pre-step', ({ agent, messages }, next) => {
            if (messages.some((message) => message.source.kind === 'user')) {
                chains.delete(agent);
                budgets.delete(agent);
            }
            return next();
        }), 'dsh-do.loop-detection-reset()');
        child.effect(() => () => {
            controller.abort();
            chains.clear();
            budgets.clear();
        }, 'dsh-do.loop-detection-teardown()');
    });
}
//# sourceMappingURL=loop-detect.js.map