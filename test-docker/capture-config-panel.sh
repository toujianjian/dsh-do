#!/usr/bin/env bash
# 抓 /config 面板的真实渲染，作为"现在到底长什么样"的基线。
set -uo pipefail
export DSH_HOME=/root/.dsh
RAW=/tmp/cfg.raw
CLEAN=/tmp/cfg.txt
FIFO=/tmp/cfg.in
rm -f "$FIFO" "$RAW"

mkfifo "$FIFO"
(
  sleep 26
  printf '/config\r'
  sleep 8
  printf '\x03'
  sleep 2
) > "$FIFO" 2>/dev/null &
FEEDER=$!

cd /root
TERM=xterm-256color timeout 60 script -q -c "stty rows 50 cols 130 2>/dev/null; dsh --profile tui" "$RAW" < "$FIFO" > /dev/null 2>&1
echo "pty exit=$? (124=超时收割)"
wait $FEEDER 2>/dev/null
kill $FEEDER 2>/dev/null

sed -r 's/\x1B\[[0-9;?]*[a-zA-Z]//g; s/\x1B\][^\x07]*\x07//g; s/\x1B[()][A-Z0-9]//g; s/\x1B[>=]//g' "$RAW" | tr '\r' '\n' | grep -v '^[[:space:]]*$' > "$CLEAN"
echo "clean lines: $(wc -l < "$CLEAN")"
echo
echo "=== /config 之后的面板（尾部 55 行）==="
tail -55 "$CLEAN"
