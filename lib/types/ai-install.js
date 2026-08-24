/**
 * "AI install" bridge: the browser half POSTs a generated install prompt to
 * `/dsh-do/ai-install`; the host creates a fresh agent session and follows up
 * with that prompt, so a brand-new session starts installing the plugin on
 * its own. The created session appears in the normal session list.
 *
 * @module dsh-do/ai-install
 */
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
 * The DeepSeek Harness home / installation root, honoring `$DSH_HOME` and
 * defaulting to `~/.dsh` — the directory under which profiles (and thus plugin
 * installs) live.
 */
function resolveDshHome() {
    const configured = process.env.DSH_HOME;
    if (typeof configured === 'string' && configured.trim() !== '')
        return configured;
    return join(homedir(), '.dsh');
}
/** Sub-directory under the DSH home where AI-install workspaces live. */
const INSTALL_WORKSPACES_DIR = 'dsh-do-installs';
/**
 * Create a dedicated workspace for one AI-install session: a fresh folder under
 * the DSH home (`$DSH_HOME/dsh-do-installs/install-<uuid>`), registered with
 * the durable workspace registry so it shows up as a real workspace in the
 * sidebar and owns a stable cwd the install agent works inside. The folder is
 * always newly minted (a random suffix), so concurrent installs never collide
 * and the install agent never runs inside another user workspace.
 * @param child - the plugin's sibling context (for `workspaceRegistry`).
 * @returns the absolute existing directory to use as the session cwd.
 */
async function createInstallWorkspace(child) {
    const dir = join(resolveDshHome(), INSTALL_WORKSPACES_DIR, `install-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    const registry = child.get('workspaceRegistry');
    if (registry !== undefined && typeof registry.create === 'function') {
        await registry.create(dir, 'DSH 插件安装');
    }
    return dir;
}
/**
 * Resolve the model route the spawned install agent needs to assemble its
 * persona: the deployment default selection first, then any live agent.
 * The cwd is handled separately (a freshly created install workspace); only
 * `{{model}}` is resolved here.
 */
function resolveModelRoute(child) {
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
    for (const agent of child.agents.list()) {
        if (provider !== undefined && model !== undefined)
            break;
        const candidateProvider = agent.options?.provider;
        const candidateModel = agent.options?.model;
        if (candidateProvider === undefined || candidateModel === undefined)
            continue;
        if (typeof candidateProvider === 'string' && candidateProvider !== '' && typeof candidateModel === 'string' && candidateModel !== '') {
            provider = candidateProvider;
            model = candidateModel;
        }
    }
    if (provider === undefined || model === undefined)
        return undefined;
    return { provider, model };
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
                    // new agent must carry a model route and a working directory. The
                    // cwd is a freshly created workspace under the DSH home, so the
                    // install agent never runs inside another user workspace.
                    const route = resolveModelRoute(child);
                    if (route === undefined) {
                        json(res, 500, { ok: false, error: 'no model route available (agentDefaultModel has no selection and no live agent has provider/model)' });
                        return;
                    }
                    const cwd = await createInstallWorkspace(child);
                    // A fresh session needs the deployment's agent preset mounted in its
                    // scope to see the normal tool registry (bash/fs/web/…). Without it
                    // the agent resolves its prompt/tools against the empty global layer
                    // and cannot execute anything. Mirror the pattern dsh-subagent uses
                    // when creating children: compose in the factory `setup`, and record
                    // the preset id in the session meta for reconstructability.
                    const agentPresets = child.get('agentPresets');
                    const presetId = agentPresets !== undefined && typeof agentPresets.defaultId === 'string' && agentPresets.defaultId !== ''
                        ? agentPresets.defaultId
                        : undefined;
                    const handle = await child.agents.create({
                        sessionId,
                        agentOptions: route,
                        meta: {
                            cwd,
                            ...(presetId !== undefined ? { agentPreset: presetId } : {}),
                        },
                        setup: async (agentCtx) => {
                            if (presetId !== undefined)
                                await agentCtx.get('agentPresets')?.mount(agentCtx, presetId);
                        },
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