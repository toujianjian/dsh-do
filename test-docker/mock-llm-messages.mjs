/**
 * 本地 mock LLM（0.2.x 版）：DeepSeek 的 **Messages** 协议流式响应。
 *
 * 为什么需要这一版：0.1.x 的适配器说 OpenAI 的 `chat.completion.chunk`，而
 * 0.2.0-rc.2 的 `@deepseek-ai/dsh-llm-deepseek` 说 Messages 协议，并且逐帧校验：
 *
 *   if (typeof event.type !== "string"
 *       || frame.event !== void 0 && frame.event !== event.type)
 *     throw new LlmError("DeepSeek Messages SSE event type mismatch", "MALFORMED_RESPONSE")
 *
 * 所以每帧 `data:` 的 JSON 必须带字符串 `type`；带 `event:` 时必须与 `type` 相同。
 * 事件序列与硬性规则（取自该适配器的 translate()）：
 *   message_start           必须是第一帧，且只出现一次；message.usage 提供 input_tokens
 *   content_block_start     需要 index(≥0 整数) + content_block
 *                           text: {type:'text', text} / tool_use: {type:'tool_use', id, name, input:{...}}
 *   content_block_delta     需要 index + delta（text_delta / input_json_delta ...）
 *   content_block_stop      需要 index
 *   message_delta           delta.stop_reason ∈ end_turn|stop_sequence|tool_use|max_tokens
 *   message_stop            必须已有 stop_reason 且所有块已关闭
 * 另外：stop 时若一个块都没有 → EMPTY_RESPONSE；tool_use 的 input 必须是对象。
 *
 * 剧本（按请求体里的 `Round: N/M` 判定）：
 *   第 1、2 轮 → 文本回复；第 3 轮 → 调用 loop_done；看到 loop_complete → 收尾文本。
 * 每个请求往 /tmp/mock-llm.jsonl 记一行，作为「真的跑了几轮」的独立证据。
 */
import http from 'node:http'
import { appendFileSync } from 'node:fs'

const PORT = Number(process.env.MOCK_PORT ?? 8899)
const LOG = process.env.MOCK_LOG ?? '/tmp/mock-llm.jsonl'

const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`

const sse = (res, frames) => {
	res.writeHead(200, {
		'content-type': 'text/event-stream',
		'cache-control': 'no-cache',
		connection: 'keep-alive',
	})
	for (const payload of frames) res.write(frame(payload))
	res.end()
}

const messageStart = (input = 100) => ({
	type: 'message_start',
	message: {
		id: 'msg_mock',
		type: 'message',
		role: 'assistant',
		model: 'deepseek-flash',
		content: [],
		usage: { input_tokens: input, output_tokens: 0 },
	},
})

/** 一段纯文本回复：一个 text 块，end_turn 收尾。 */
const textReply = (text) => [
	messageStart(),
	{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
	{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
	{ type: 'content_block_stop', index: 0 },
	{ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } },
	{ type: 'message_stop' },
]

/** 一次工具调用：一个 tool_use 块，tool_use 收尾。 */
const toolCallReply = (id, name, input) => [
	messageStart(120),
	{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input } },
	{ type: 'content_block_stop', index: 0 },
	{ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } },
	{ type: 'message_stop' },
]

const server = http.createServer((req, res) => {
	if (req.method === 'GET' && req.url === '/health') {
		res.writeHead(200, { 'content-type': 'text/plain' })
		res.end('ok')
		return
	}
	let raw = ''
	req.on('data', (chunk) => { raw += chunk })
	req.on('end', () => {
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
			url: req.url,
			round,
			isWrapup,
			action,
			bytes: raw.length,
		})}\n`)

		if (action === 'loop_done') {
			sse(res, toolCallReply(`call_mock_${round}`, 'loop_done', { summary: `mock 在第 ${round} 轮判定目标达成` }))
			return
		}
		const text = action === 'wrapup-text'
			? '循环已完成：mock 在第 3 轮调用 loop_done 收尾。'
			: action === 'non-loop-text'
				? 'mock 标题'
				: `mock 第 ${round} 轮：继续推进目标。`
		sse(res, textReply(text))
	})
})

server.listen(PORT, '127.0.0.1', () => {
	appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), event: 'listening', port: PORT, protocol: 'messages' })}\n`)
	console.log(`mock-llm(messages) listening on 127.0.0.1:${PORT}`)
})
