/**
 * "AI install" bridge: the browser half POSTs a generated install prompt to
 * `/dsh-do/ai-install`; the host creates a fresh agent session and follows up
 * with that prompt, so a brand-new session starts installing the plugin on
 * its own. The created session appears in the normal session list.
 *
 * @module dsh-do/ai-install
 */
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm';
/** Route and body budget for the bridge. */
export const AI_INSTALL_PATH = '/dsh-do/ai-install';
const MAX_BODY_BYTES = 64 * 1024;
/** Read and JSON-parse a bounded request body. */
export async function readJsonBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_BODY_BYTES)
            throw new Error('request body too large');
        chunks.push(buffer);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return text.length === 0 ? undefined : JSON.parse(text);
}
/** Write a JSON response with a stable cache policy. */
function json(res, status, value) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(value));
}
/**
 * Resolve everything the spawned install agent needs to assemble its persona:
 * a model route (deployment default, then any live agent) and a cwd (a live
 * agent's session cwd, then the deployment workspace root, then home) —
 * `{{model}}` and `{{cwd}}` in the persona must both have values.
 */
function resolveSpawnFacts(child) {
    const defaultModel = child.get('agentDefaultModel');
    let provider;
    let model;
    if (typeof defaultModel?.currentSelection === 'function') {
        try {
            const selection = defaultModel.currentSelection();
            if (selection !== undefined &&
                typeof selection.provider === 'string' && selection.provider !== '' &&
                typeof selection.model === 'string' && selection.model !== '') {
                provider = selection.provider;
                model = selection.model;
            }
        }
        catch {
            /* fall through to live agents */
        }
    }
    let cwd;
    for (const agent of child.agents.list()) {
        if (provider === undefined || model === undefined) {
            const candidateProvider = agent.options?.provider;
            const candidateModel = agent.options?.model;
            if (typeof candidateProvider === 'string' && candidateProvider !== '' && typeof candidateModel === 'string' && candidateModel !== '') {
                provider = candidateProvider;
                model = candidateModel;
            }
        }
        if (cwd === undefined) {
            const candidateCwd = agent.session?.header?.cwd;
            if (typeof candidateCwd === 'string' && candidateCwd !== '')
                cwd = candidateCwd;
        }
        if (provider !== undefined && model !== undefined && cwd !== undefined)
            break;
    }
    if (provider === undefined || model === undefined)
        return undefined;
    const sandbox = child.get('sandboxPolicy');
    const fallbackCwd = typeof sandbox?.workspaceRoot === 'string' && sandbox.workspaceRoot !== '' ? sandbox.workspaceRoot : homedir();
    const resolvedCwd = cwd !== undefined ? cwd : fallbackCwd;
    return { agentOptions: { provider, model }, cwd: resolvedCwd };
}
/**
 * Install the `POST /dsh-do/ai-install` route. Lazy sibling injection for the
 * web server; the agents service is required to spawn the install session.
 * @param ctx - the plugin context.
 */
export function installAiInstallRoute(ctx) {
    ctx.inject(['webServer', 'agents', 'agentDefaultModel'], (child) => {
        const server = child.get('webServer');
        child.effect(() => server.register({
            kind: 'exact',
            path: AI_INSTALL_PATH,
            handler: async (req, res) => {
                if (req.method !== 'POST') {
                    json(res, 405, { ok: false, error: 'method not allowed (use POST)' });
                    return;
                }
                let body;
                try {
                    body = await readJsonBody(req);
                }
                catch (error) {
                    json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
                    return;
                }
                const prompt = typeof body === 'object' && body !== null && typeof body.prompt === 'string'
                    ? body.prompt.trim()
                    : '';
                if (prompt.length === 0) {
                    json(res, 400, { ok: false, error: 'prompt is required' });
                    return;
                }
                try {
                    const sessionId = `dsh-do-install-${randomUUID()}`;
                    // The persona template renders `{{model}}` and `{{cwd}}`, so the
                    // new agent must carry a model route and a working directory.
                    const facts = resolveSpawnFacts(child);
                    if (facts === undefined) {
                        json(res, 500, { ok: false, error: 'no model route available (agentDefaultModel has no selection and no live agent has provider/model)' });
                        return;
                    }
                    const handle = await child.agents.create({
                        sessionId,
                        agentOptions: facts.agentOptions,
                        meta: { cwd: facts.cwd },
                    });
                    handle.agent.followup(createUserMessage({
                        content: [{ type: 'text', text: prompt }],
                        source: {
                            kind: 'plugin',
                            plugin: 'dsh-do',
                            form: 'notice',
                            summary: boundContextSummary(`AI install: ${prompt.slice(0, 60)}`),
                        },
                    }));
                    json(res, 200, { ok: true, sessionId });
                }
                catch (error) {
                    json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
                }
            },
        }, 'dsh-do.ai-install-route()'));
    });
}
//# sourceMappingURL=ai-install.js.map