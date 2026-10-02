/**
 * "AI install" bridge: the browser half POSTs a generated install prompt to
 * `/dsh-do/ai-install`; the host creates a fresh agent session and follows up
 * with that prompt, so a brand-new session starts installing the plugin on
 * its own. The created session appears in the normal session list.
 *
 * @module dsh-do/ai-install
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rmdir } from 'node:fs/promises';
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
    try {
        const workspace = await registry.create(dir, 'DSH 插件安装');
        return {
            path: dir,
            rollback: async () => {
                await registry.delete(workspace.id);
                // Never recursively delete a workspace: preserve any files a failed
                // setup may already have created. Only empty owned directories go.
                await rmdir(dir).catch(() => undefined);
            },
        };
    }
    catch (error) {
        await rmdir(dir).catch(() => undefined);
        throw error;
    }
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
                    res.setHeader('Allow', 'POST');
                    json(res, 405, { ok: false, error: 'method not allowed (use POST)' });
                    return;
                }
                // Browser requests must originate from this host. Requiring JSON also
                // prevents cross-origin HTML forms from submitting install prompts.
                const origin = req.headers.origin;
                let foreignOrigin = false;
                if (origin !== undefined) {
                    try {
                        const url = new URL(origin);
                        foreignOrigin = !['http:', 'https:'].includes(url.protocol) || url.host !== req.headers.host;
                    }
                    catch {
                        foreignOrigin = true;
                    }
                }
                if (foreignOrigin || req.headers['sec-fetch-site'] === 'cross-site') {
                    json(res, 403, { ok: false, error: 'cross-site installation request denied' });
                    return;
                }
                if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
                    json(res, 415, { ok: false, error: 'application/json is required' });
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
                let rollbackWorkspace;
                let disposeAgent;
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
                    if (presetId === undefined || typeof agentPresets?.mount !== 'function' || typeof child.get('workspaceRegistry')?.create !== 'function' || typeof child.get('workspaceRegistry')?.delete !== 'function') {
                        json(res, 503, { ok: false, error: 'installation requires an agent preset and workspace registry' });
                        return;
                    }
                    const workspace = await createInstallWorkspace(child);
                    rollbackWorkspace = workspace.rollback;
                    const cwd = workspace.path;
                    const handle = await child.agents.create({
                        sessionId,
                        agentOptions: route,
                        meta: {
                            cwd,
                            ...(presetId !== undefined ? { agentPreset: presetId } : {}),
                        },
                        setup: async (agentCtx) => {
                            await agentPresets.mount(agentCtx, presetId);
                        },
                    });
                    disposeAgent = () => handle.dispose();
                    handle.agent.followup(createUserMessage({
                        content: [{ type: 'text', text: prompt }],
                        source: {
                            kind: 'plugin',
                            plugin: 'dsh-do',
                            form: 'notice',
                            summary: boundContextSummary(`AI install: ${prompt.slice(0, 60)}`),
                        },
                    }));
                    // Once queued, the installation session and workspace are durable
                    // user-visible results, not resources to roll back on HTTP failure.
                    disposeAgent = undefined;
                    rollbackWorkspace = undefined;
                    json(res, 200, { ok: true, sessionId });
                }
                catch (error) {
                    try {
                        await disposeAgent?.();
                        await rollbackWorkspace?.();
                    }
                    catch (cleanupError) {
                        child.logger.warn(`dsh-do: install rollback failed: ${String(cleanupError)}`);
                    }
                    json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
                }
            },
        }, 'dsh-do.ai-install-route()'));
    });
}
//# sourceMappingURL=ai-install.js.map