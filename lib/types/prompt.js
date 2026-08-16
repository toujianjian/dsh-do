/**
 * Render the complete round instruction retained in session history.
 * @param objective - the loop's concrete completion objective.
 * @param round - the next positive round number.
 * @param maxRounds - the loop's round budget.
 * @returns a fresh one-block prompt for `Agent.followup()`.
 */
export function renderLoopRoundPrompt(objective, round, maxRounds) {
    return [
        {
            type: 'text',
            text: `<loop_round>
Objective: ${JSON.stringify(objective)}
Round: ${round}/${maxRounds}

Continue working toward the objective in this same session. Treat the current workspace, tool results, and durable session state as authoritative; inspect them instead of assuming earlier narration is still current. Make concrete progress and verify the result. If the objective is achieved, call loop_done with a short summary. If you are genuinely blocked, call loop_cancel with the concrete reason. Otherwise leave the loop active for the next round.
</loop_round>`,
        },
    ];
}
/**
 * Render the closing-message instruction injected after an autonomous loop
 * round reports `loop_done` or `loop_cancel`, so the model still addresses
 * the user once before the turn ends.
 * @param objective - the terminal loop's objective, echoed for grounding.
 * @param ending - the validated terminal report.
 * @returns a fresh one-block context for `ToolRunContext.deferContext()`.
 */
export function renderLoopWrapupContext(objective, ending) {
    const heading = `Objective: ${JSON.stringify(objective)}\n`;
    if (ending.kind === 'completed') {
        const detail = ending.summary === undefined ? '' : `Summary: ${JSON.stringify(ending.summary)}\n`;
        return [
            {
                type: 'text',
                text: `<loop_complete>
${heading}${detail}The loop is complete and this autonomous run is ending. Write the closing message to the user now: state the outcome, summarize what was done and how it was verified, and point to the concrete results (files, commits, or other artifacts). Report only what earlier rounds and tool results in this session actually establish; when a detail is not in the session, say so instead of inventing it. Note anything the user should review or do next. Address the user directly. Do not call any more tools in this run; further work waits for the user's next instruction.
</loop_complete>`,
            },
        ];
    }
    const detail = ending.reason === undefined ? '' : `Reason: ${JSON.stringify(ending.reason)}\n`;
    return [
        {
            type: 'text',
            text: `<loop_cancelled>
${heading}${detail}The loop is cancelled and this autonomous run is ending. Write the closing message to the user now: state what has been completed so far, describe the concrete blocking condition and what you tried, and say exactly what you need from the user to continue. Report only what earlier rounds and tool results in this session actually establish; when a detail is not in the session, say so instead of inventing it. Address the user directly. Do not call any more tools in this run; further work waits for the user's next instruction.
</loop_cancelled>`,
        },
    ];
}
//# sourceMappingURL=prompt.js.map