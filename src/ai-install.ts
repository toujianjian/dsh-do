/**
 * "AI install" bridge: the browser half POSTs a generated install prompt to
 * `/dsh-do/ai-install`; the host creates a fresh agent session and follows up
 * with that prompt, so a brand-new session starts installing the plugin on
 * its own. The created session appears in the normal session list.
 *
 * @module dsh-do/ai-install
 */
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'

/** Route and body budget for the bridge. */
export const AI_INSTALL_PATH = '/dsh-do/ai-install'
const MAX_BODY_BYTES = 64 * 1024

/** Read and JSON-parse a bounded request body. */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text.length === 0 ? undefined : (JSON.parse(text) as unknown)
}

/** Write a JSON response with a stable cache policy. */
function json(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(value))
}

/**
 * Install the `POST /dsh-do/ai-install` route. Lazy sibling injection for the
 * web server; the agents service is required to spawn the install session.
 * @param ctx - the plugin context.
 */
export function installAiInstallRoute(ctx: Context): void {
  ctx.inject(['webServer', 'agents'], (child) => {
    const server = child.get('webServer')
    child.effect(
      () => server.register({
        kind: 'exact',
        path: AI_INSTALL_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'POST') {
            json(res, 405, { ok: false, error: 'method not allowed (use POST)' })
            return
          }
          let body: unknown
          try {
            body = await readJsonBody(req)
          } catch (error) {
            json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
            return
          }
          const prompt = typeof body === 'object' && body !== null && typeof (body as { prompt?: unknown }).prompt === 'string'
            ? (body as { prompt: string }).prompt.trim()
            : ''
          if (prompt.length === 0) {
            json(res, 400, { ok: false, error: 'prompt is required' })
            return
          }
          try {
            const sessionId = `dsh-do-install-${randomUUID()}` as SessionId
            const handle = await child.agents.create({ sessionId })
            handle.agent.followup(createUserMessage({
              content: [{ type: 'text', text: prompt }],
              source: {
                kind: 'plugin',
                plugin: 'dsh-do',
                form: 'notice',
                summary: boundContextSummary(`AI install: ${prompt.slice(0, 60)}`),
              },
            }))
            json(res, 200, { ok: true, sessionId })
          } catch (error) {
            json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
      }, 'dsh-do.ai-install-route()'),
    )
  })
}
