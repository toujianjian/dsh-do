/**
 * Decide whether to continue after an output-limit cut-off.
 *
 * @param policy - the live auto-continue settings.
 * @param streak - continuations already queued since the last turn that did
 *   NOT end at the output limit.
 * @param looping - whether an armed dsh-DO loop owns this session.
 * @returns the decision.
 */
export function decideAutoContinue(policy, streak, looping) {
    if (!policy.enabled)
        return { kind: 'stop', reason: 'disabled' };
    if (policy.onlyWhileLooping && !looping)
        return { kind: 'stop', reason: 'not-looping' };
    if (streak >= policy.maxContinuations)
        return { kind: 'stop', reason: 'exhausted' };
    return { kind: 'continue', attempt: streak + 1 };
}
/**
 * Model-visible text of a continuation turn.
 *
 * It asks for a seamless resume, not a restart: a model that re-answers from the
 * top would hit the same limit again and never finish.
 *
 * @param attempt - this continuation's number, from 1.
 * @param max - the configured cap.
 * @returns a fresh one-block prompt for `Agent.followup()`.
 */
export function renderAutoContinuePrompt(attempt, max) {
    return [
        {
            type: 'text',
            text: `<output_limit_continue>
Your previous response was cut off by the model output-token limit (automatic continuation ${attempt}/${max}).
Continue exactly where it stopped. Do not restart, repeat, or summarise what you already wrote; if you were in the middle of a code block or a tool call, resume it. Keep the remaining output compact so it fits.
</output_limit_continue>`,
        },
    ];
}
/** Pause-notice message for a `max-tokens` stop that was not continued. */
export function describeAutoContinueStop(reason, max) {
    switch (reason) {
        case 'exhausted':
            return `the model hit its output limit ${max} times in a row; automatic continuation gave up so a runaway response cannot loop forever`;
        case 'not-looping':
            return 'the last round hit the model output limit';
        case 'disabled':
            return 'the last round hit the model output limit and automatic continuation is turned off';
    }
}
//# sourceMappingURL=auto-continue.js.map