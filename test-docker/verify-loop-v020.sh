#!/usr/bin/env bash
# 0.2.0-rc.2 (session format v4) 多轮循环验收：TUI 里 `/loop 1m <目标>`，provider 指向容器内 mock。
#
# 目的：在真正会拒绝 kind:'plugin' 的运行时上，验证 dsh-do 的通知能被写进会话日志
# ——第 1、2 轮文本回复，第 3 轮调用 loop_done 收尾（收尾上下文也是 dsh-do 的通知）。
set -uo pipefail
export DSH_HOME=/root/.dsh
export DEEPSEEK_API_KEY=dummy-mock-key

RAW=/tmp/v020.raw
CLEAN=/tmp/v020.clean.txt
FIFO=/tmp/v020.in
MLOG=/tmp/mock-llm.jsonl

echo "############ v020 多轮循环验收（mock LLM）############"
rm -f "$FIFO" "$RAW" "$MLOG"

echo
echo "=== 1) 启动 mock LLM（Messages 协议）==="
node /root/mock-llm-messages.mjs > /tmp/mock-llm.out 2>&1 &
MOCK=$!
HEALTH=""
for _ in $(seq 1 25); do
  HEALTH=$(node -e "fetch('http://127.0.0.1:8899/health').then(r=>console.log(r.status)).catch(()=>console.log(''))" 2>/dev/null)
  [ "$HEALTH" = "200" ] && break
  sleep 0.3
done
echo "mock health=$HEALTH pid=$MOCK"

echo
echo "=== 2) 跑 TUI：/loop 1m -> 等 170s -> /status ==="
mkfifo "$FIFO"
(
  sleep 6
  printf '\033'          # 关掉新版 TUI 的首启模态
  sleep 22
  printf '/loop 1m verify the producer-owned source fix\r'
  sleep 170
  printf '/status\r'
  sleep 16
  printf '\x03'
  sleep 2
) > "$FIFO" 2>/dev/null &
FEEDER=$!

cd /root
TERM=xterm-256color timeout 260 script -q -c "stty rows 50 cols 130 2>/dev/null; dsh --profile v020 --patch /root/mock-patch.yml" "$RAW" < "$FIFO" > /dev/null 2>&1
echo "pty exit=$? (124 = 超时收割，非崩溃)"
wait $FEEDER 2>/dev/null
kill $FEEDER 2>/dev/null
sleep 1
kill $MOCK 2>/dev/null

clean() { sed -r 's/\x1B\[[0-9;?]*[a-zA-Z]//g; s/\x1B\][^\x07]*\x07//g; s/\x1B[()][A-Z0-9]//g; s/\x1B[>=]//g' "$RAW" | tr '\r' '\n' | grep -v '^[[:space:]]*$'; }
clean > "$CLEAN"
echo "raw bytes: $(wc -c < "$RAW"), clean lines: $(wc -l < "$CLEAN")"

echo
echo "=== 3) mock 收到的请求（第几轮真的跑了）==="
cat "$MLOG" 2>/dev/null || echo "(mock log 为空)"

echo
echo "=== 4) 回合出错 / 格式 v4 报错 ==="
grep -n -i 'producer-owned\|回合出错\|SessionFormatError' "$CLEAN" | head -10 || echo "(无：通知没有被打回)"

echo
echo "=== 5) 界面上的 mock 回复 ==="
grep -n 'mock ' "$CLEAN" | head -20

echo
echo "=== 6) ◆ 循环 段 ==="
grep -n -A6 '◆ 循环' "$CLEAN" | head -30

echo
echo "=== 7) 检查点 ==="
for f in "$DSH_HOME"/loops/*.json; do
  [ -f "$f" ] || continue
  echo "### $f"; cat "$f"; echo
done
echo "############ done ############"
