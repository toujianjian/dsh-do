#!/usr/bin/env bash
# 真实多轮循环验证：TUI 里 `/loop 1m <目标>`，provider 指向容器内的 mock LLM。
#
# 为什么这么做：容器没有真实凭证，正常情况循环第 1 轮就因 API 报错而暂停，
# 「一轮轮跑下去」和「loop_done 收尾」永远测不到。mock 顶上 baseURL 后可以真跑，
# 且不需要外网（容器保持断网，也就不会触发 TUI 自我升级）。
#
# 剧本：第 1、2 轮文本回复；第 3 轮调用 loop_done 收尾。
# 证据：① 界面上的 mock 回复 ② /tmp/mock-llm.jsonl（独立计数）③ 检查点 roundsStarted
set -uo pipefail
export DSH_HOME=/root/.dsh
export DEEPSEEK_API_KEY=dummy-mock-key

RAW=/tmp/multiround.raw
CLEAN=/tmp/multiround.clean.txt
FIFO=/tmp/multiround.in
MLOG=/tmp/mock-llm.jsonl

echo "############ 多轮循环验证（mock LLM）############"
rm -f "$FIFO" "$RAW" "$MLOG"

echo
echo "=== 1) 启动 mock LLM ==="
node /root/mock-llm.mjs > /tmp/mock-llm.out 2>&1 &
MOCK=$!
HEALTH=""
for _ in $(seq 1 25); do
  HEALTH=$(node -e "fetch('http://127.0.0.1:8899/health').then(r=>console.log(r.status)).catch(()=>console.log(''))" 2>/dev/null)
  [ "$HEALTH" = "200" ] && break
  sleep 0.3
done
echo "mock health=$HEALTH pid=$MOCK"

echo
echo "=== 2) 跑 TUI：/loop 1m -> 等 150s -> /status ==="
mkfifo "$FIFO"
(
  sleep 28
  printf '/loop 1m 多轮循环验证目标\r'
  sleep 150
  printf '/status\r'
  sleep 16
  printf '\x03'
  sleep 2
) > "$FIFO" 2>/dev/null &
FEEDER=$!

cd /root
TERM=xterm-256color timeout 240 script -q -c "stty rows 50 cols 130 2>/dev/null; dsh --profile tui --patch /root/mock-patch.yml" "$RAW" < "$FIFO" > /dev/null 2>&1
echo "pty exit=$? (124 = 超时收割，非崩溃)"
wait $FEEDER 2>/dev/null
kill $FEEDER 2>/dev/null
sleep 1
kill $MOCK 2>/dev/null

clean() { sed -r 's/\x1B\[[0-9;?]*[a-zA-Z]//g; s/\x1B\][^\x07]*\x07//g; s/\x1B[()][A-Z0-9]//g; s/\x1B[>=]//g' "$RAW" | tr '\r' '\n' | grep -v '^[[:space:]]*$'; }
clean > "$CLEAN"
echo "raw bytes: $(wc -c < "$RAW"), clean lines: $(wc -l < "$CLEAN")"

echo
echo "=== 3) mock 收到的请求（独立证据）==="
cat "$MLOG" 2>/dev/null || echo "(mock log 为空)"
echo "--- mock stderr ---"
cat /tmp/mock-llm.out 2>/dev/null | tail -5

echo
echo "=== 4) 启动期错误 ==="
grep -n -i 'failed to load\|not a function\|ERR_' "$CLEAN" | head -10 || echo "(无)"

echo
echo "=== 5) 界面上的 mock 回复（第几轮真的跑了）==="
grep -n 'mock 第\|mock 标题' "$CLEAN" | head -20

echo
echo "=== 6) ◆ 循环 段 ==="
grep -n -A6 '◆ 循环' "$CLEAN" | head -40

echo
echo "=== 7) loop_done / 收尾 相关 ==="
grep -n -i 'loop_done\|收尾\|已完成\|loop_complete' "$CLEAN" | head -20

echo
echo "=== 8) /status 面板尾部 ==="
tail -28 "$CLEAN"

echo
echo "=== 9) 检查点 ==="
ls -la "$DSH_HOME/loops/" 2>/dev/null | tail -4
for f in "$DSH_HOME"/loops/*.json; do
  [ -f "$f" ] || continue
  echo "### $f"; cat "$f"; echo
done
echo "############ done ############"
