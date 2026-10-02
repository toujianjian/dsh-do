#!/usr/bin/env bash
# 目标：在真实 TTY 里看到 /status 的「◆ 循环」段。
# 该段只在 loop 投影非空时渲染，所以先 /loop 起一个循环，再 /status。
set -uo pipefail
export DSH_HOME=/root/.dsh
RAW=/tmp/loop-out.raw

echo "=== boot + /loop + /status ==="
rm -f /tmp/loop-in "$RAW"
mkfifo /tmp/loop-in
(
  sleep 25
  printf '/loop\r'
  sleep 8
  printf '/loop 验证状态栏循环段\r'
  sleep 14
  printf '/status\r'
  sleep 16
  printf '\x03'
  sleep 2
) > /tmp/loop-in 2>/dev/null &
FEEDER=$!

cd /root
TERM=xterm-256color timeout 110 script -q -c "stty rows 50 cols 130 2>/dev/null; dsh --profile tui" "$RAW" < /tmp/loop-in > /dev/null 2>&1
echo "pty exit=$?"
wait $FEEDER 2>/dev/null
kill $FEEDER 2>/dev/null

clean() { sed -r 's/\x1B\[[0-9;?]*[a-zA-Z]//g; s/\x1B\][^\x07]*\x07//g; s/\x1B[()][A-Z0-9]//g; s/\x1B[>=]//g' "$RAW" | tr '\r' '\n' | grep -v '^[[:space:]]*$'; }
clean > /tmp/loop-clean.txt
echo "raw bytes: $(wc -c < "$RAW"), clean lines: $(wc -l < /tmp/loop-clean.txt)"

echo
echo "=== '◆' occurrences ==="
grep -n '◆' /tmp/loop-clean.txt | head || echo "(none)"

echo
echo "=== context around /loop result and status panel ==="
grep -n -A22 '/loop 验证状态栏循环段' /tmp/loop-clean.txt | head -40

echo
echo "=== last 60 lines ==="
tail -60 /tmp/loop-clean.txt
echo "=== done ==="
