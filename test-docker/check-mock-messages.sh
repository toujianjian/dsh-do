#!/usr/bin/env bash
# 先用一次真实请求验证 mock 的帧是否满足 0.2.x 适配器的逐帧校验规则：
#   - 每帧 data 的 JSON 必须带字符串 type
#   - message_start 必须第一帧且唯一
#   - 内容事件必须在 message_start 之后
#   - message_stop 必须已有 stop_reason
# 这一步 10 秒，避免白跑 4 分钟 TUI 才发现 mock 写错。
pkill -f mock-llm-messages.mjs 2>/dev/null
sleep 0.3
rm -f /tmp/mock-check.jsonl
MOCK_LOG=/tmp/mock-check.jsonl node /root/mock-llm-messages.mjs > /tmp/mock-check.out 2>&1 &
for _ in $(seq 1 20); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8899/health)" = "200" ] && break
  sleep 0.3
done

echo "=== 文本回复（第 1 轮）==="
curl -s -X POST http://127.0.0.1:8899/v1/messages \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"<loop_round>\nRound: 1/20\n"}]}' > /tmp/mock-text.sse
node -e '
const fs=require("fs");
const raw=fs.readFileSync("/tmp/mock-text.sse","utf8");
const frames=raw.split("\n\n").filter(f=>f.startsWith("data: ")).map(f=>JSON.parse(f.slice(6)));
let started=false,reason=void 0,open=new Set(),problems=[];
for(const [i,e] of frames.entries()){
  if(typeof e.type!=="string") problems.push(`frame ${i}: type 不是字符串`);
  if(e.type==="message_start"){ if(started) problems.push("重复 message_start"); started=true; continue; }
  if(["content_block_start","content_block_delta","content_block_stop","message_delta","message_stop"].includes(e.type)){
    if(!started) problems.push(`frame ${i}: ${e.type} 早于 message_start`);
  }
  if(e.type==="content_block_start") open.add(e.index);
  if(e.type==="content_block_stop") open.delete(e.index);
  if(e.type==="message_delta"&&e.delta&&e.delta.stop_reason) reason=e.delta.stop_reason;
}
if(frames.at(-1)?.type!=="message_stop") problems.push("最后一帧不是 message_stop");
if(reason===void 0) problems.push("message_stop 前没有 stop_reason");
if(open.size) problems.push("还有未关闭的块");
console.log("frames:",frames.length,"types:",frames.map(f=>f.type).join(","));
console.log("stop_reason:",reason,"| 校验:",problems.length?"✗ "+problems.join("; "):"✓ 通过");
'

echo
echo "=== 工具调用回复（第 3 轮）==="
curl -s -X POST http://127.0.0.1:8899/v1/messages \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"<loop_round>\nRound: 3/20\n"}]}' > /tmp/mock-tool.sse
node -e '
const fs=require("fs");
const frames=fs.readFileSync("/tmp/mock-tool.sse","utf8").split("\n\n").filter(f=>f.startsWith("data: ")).map(f=>JSON.parse(f.slice(6)));
const start=frames.find(f=>f.type==="content_block_start");
console.log("types:",frames.map(f=>f.type).join(","));
console.log("tool:",start.content_block.name,"| input:",JSON.stringify(start.content_block.input));
console.log("stop_reason:",frames.find(f=>f.type==="message_delta").delta.stop_reason);
'

echo
echo "=== mock 日志 ==="
cat /tmp/mock-check.jsonl
pkill -f mock-llm-messages.mjs 2>/dev/null
echo "(mock 已停)"
