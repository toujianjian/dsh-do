#!/usr/bin/env bash
# mock LLM 自检：健康检查、普通请求、第 3 轮（应返回 loop_done 工具调用）。
set -uo pipefail
rm -f /tmp/mock-llm.jsonl
node /root/mock-llm.mjs > /tmp/mock-selftest.out 2>&1 &
MOCK=$!
sleep 1

echo "--- health ---"
node -e "fetch('http://127.0.0.1:8899/health').then(r=>r.text()).then(t=>console.log('health:',t)).catch(e=>console.log('ERR',e.message))"

echo "--- 普通请求（应回文本 + [DONE]）---"
node -e "
fetch('http://127.0.0.1:8899/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({stream:true,messages:[{role:'user',content:'hi'}]})})
 .then(async r=>{const t=await r.text();console.log('status',r.status);console.log(t.slice(0,300))})
 .catch(e=>console.log('ERR',e.message))
"
sleep 0.5

echo "--- 第 3 轮（应回 tool_calls loop_done）---"
node -e "
const body={stream:true,messages:[{role:'user',content:'<loop_round>\nObjective: \"x\"\nRound: 3/20\n\nContinue\n</loop_round>'}]};
fetch('http://127.0.0.1:8899/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
 .then(async r=>{const t=await r.text();console.log('status',r.status);console.log(t.slice(0,500))})
 .catch(e=>console.log('ERR',e.message))
"
sleep 0.5

echo "--- 收尾请求（含 loop_complete，应回文本）---"
node -e "
const body={stream:true,messages:[{role:'user',content:'<loop_complete>\nObjective: \"x\"\nWrite the closing message\n</loop_complete>'}]};
fetch('http://127.0.0.1:8899/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
 .then(async r=>{const t=await r.text();console.log('status',r.status);console.log(t.slice(0,300))})
 .catch(e=>console.log('ERR',e.message))
"

sleep 0.5
kill $MOCK 2>/dev/null
echo
echo "--- mock 记录 ---"
cat /tmp/mock-llm.jsonl
echo "--- mock stderr ---"
tail -5 /tmp/mock-selftest.out
