/**
 * 本地 mock LLM（模型自动切换专用）。
 *
 * 剧本：请求体里的 `model` 是「主模型」时一律回 HTTP 429（→ 错误码 RATE_LIMIT），
 * 其它模型正常回 200。于是：
 *   主模型 → 429 → 官方 dsh-llm-retry 退避重试若干轮 → 放弃 → dsh-do 切到候选模型
 *   候选模型 → 200 → 正常应答
 *
 * 200 的回复文本里会自报模型名，所以 TUI 界面上直接能看出"最后是谁答的"。
 *
 * 429 响应体刻意不含 quota 字样：provider 的 httpErrorCode 会把
 * [error.code, error.type, error.message] 拼起来先判 quota，命中就变成 QUOTA 码了。
 */
import http from 'node:http'
import { appendFileSync } from 'node:fs'

const PORT = Number(process.env.MOCK_PORT ?? 8899)
const LOG = process.env.MOCK_LOG ?? '/tmp/mock-fallback.jsonl'
const PRIMARY = process.env.MOCK_PRIMARY ?? 'deepseek-v4-flash'

const record = (entry) => appendFileSync(LOG, `${JSON.stringify(entry)}\n`)

const sse = (res, payloads) => {
	res.writeHead(200, {
		'content-type': 'text/event-stream',
		'cache-control': 'no-cache',
		connection: 'keep-alive',
	})
	for (const payload of payloads) res.write(`data: ${JSON.stringify(payload)}\n\n`)
	res.write('data: [DONE]\n\n')
	res.end()
}

const chunk = (delta, finish = null, usage = null) => {
	const body = {
		id: 'chatcmpl-mock',
		object: 'chat.completion.chunk',
		created: Math.floor(Date.now() / 1000),
		model: 'mock',
		choices: [{ index: 0, delta, finish_reason: finish }],
	}
	if (usage !== null) body.usage = usage
	return body
}

const server = http.createServer((req, res) => {
	if (req.method === 'GET' && req.url === '/health') {
		res.writeHead(200, { 'content-type': 'text/plain' })
		res.end('ok')
		return
	}
	let raw = ''
	req.on('data', (c) => { raw += c })
	req.on('end', () => {
		let model = '(unparsed)'
		try { model = JSON.parse(raw).model ?? '(none)' } catch { /* keep placeholder */ }

		if (model === PRIMARY) {
			record({ at: new Date().toISOString(), model, status: 429 })
			res.writeHead(429, { 'content-type': 'application/json' })
			res.end(JSON.stringify({
				error: {
					message: 'Rate limit reached for requests',
					type: 'rate_limit_error',
				},
			}))
			return
		}

		record({ at: new Date().toISOString(), model, status: 200 })
		sse(res, [
			chunk({ content: `我是 ${model}，由本地 mock 应答。` }),
			chunk({}, 'stop', { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }),
		])
	})
})

server.listen(PORT, '127.0.0.1', () => {
	record({ at: new Date().toISOString(), event: 'listening', port: PORT, primary: PRIMARY })
	console.log(`mock-llm-fallback listening on 127.0.0.1:${PORT} (primary ${PRIMARY} -> 429)`)
})
