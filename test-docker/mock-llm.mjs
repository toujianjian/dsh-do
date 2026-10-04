/**
 * 本地 mock LLM：DeepSeek 兼容的流式 /chat/completions。
 *
 * 目的：容器里没有真实凭证，模型调用必然失败，于是「循环能不能一轮轮跑下去」永远
 * 测不到。这个 mock 顶上 provider 的 baseURL，让循环真的跑起来，而且不烧任何额度、
 * 不需要外网（容器可以保持断网，也就不会触发 TUI 自我升级）。
 *
 * 剧本（按请求体里的 `<loop_round>` 轮次判定）：
 *   第 1 轮  → 文本回复
 *   第 2 轮  → 文本回复
 *   第 3 轮  → 调用 loop_done（验证正常收尾路径）
 *   看到 <loop_complete> → 收尾文本
 *   其它（例如会话标题生成）→ 短文本
 *
 * 每个请求都往 /tmp/mock-llm.jsonl 记一行，作为「真的跑了几轮」的独立证据。
 */
import http from 'node:http'
import { appendFileSync } from 'node:fs'

const PORT = Number(process.env.MOCK_PORT ?? 8899)
const LOG = process.env.MOCK_LOG ?? '/tmp/mock-llm.jsonl'

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
		model: 'deepseek-v4-flash',
		choices: [{ index: 0, delta, finish_reason: finish }],
	}
	if (usage !== null) body.usage = usage
	return body
}

const usage = (prompt = 100, completion = 20) => ({
	prompt_tokens: prompt,
	completion_tokens: completion,
	total_tokens: prompt + completion,
})

const server = http.createServer((req, res) => {
	if (req.method === 'GET' && req.url === '/health') {
		res.writeHead(200, { 'content-type': 'text/plain' })
		res.end('ok')
		return
	}
	let raw = ''
	req.on('data', (c) => { raw += c })
	req.on('end', () => {
		// 轮次：请求体里最后一个 `Round: N/M`（来自 renderLoopRoundPrompt）
		const rounds = [...raw.matchAll(/Round:\s*(\d+)\/(\d+)/g)]
		const round = rounds.length > 0 ? Number(rounds.at(-1)[1]) : null
		const isWrapup = raw.includes('loop_complete') || raw.includes('loop_cancelled')

		let action
		if (isWrapup) action = 'wrapup-text'
		else if (round === null) action = 'non-loop-text'
		else if (round >= 3) action = 'loop_done'
		else action = 'text'

		appendFileSync(LOG, `${JSON.stringify({
			at: new Date().toISOString(),
			round,
			isWrapup,
			action,
			bytes: raw.length,
		})}\n`)

		if (action === 'loop_done') {
			sse(res, [
				chunk({
					tool_calls: [{
						index: 0,
						id: `call_mock_${round}`,
						type: 'function',
						function: {
							name: 'loop_done',
							arguments: JSON.stringify({ summary: `mock 在第 ${round} 轮判定目标达成` }),
						},
					}],
				}),
				chunk({}, 'tool_calls', usage(120, 30)),
			])
			return
		}

		const text = action === 'wrapup-text'
			? '循环已完成：mock 在第 3 轮调用 loop_done 收尾。'
			: action === 'non-loop-text'
				? 'mock 标题'
				: `mock 第 ${round} 轮：继续推进目标。`

		sse(res, [
			chunk({ content: text }),
			chunk({}, 'stop', usage()),
		])
	})
})

server.listen(PORT, '127.0.0.1', () => {
	appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), event: 'listening', port: PORT })}\n`)
	console.log(`mock-llm listening on 127.0.0.1:${PORT}`)
})
