#!/usr/bin/env bash
# 真实 pty 下驱动 TUI：/do-config -> /status，并核对版本与补丁状态。
set -uo pipefail
export DSH_HOME=/root/.dsh
TUI_DIR="$DSH_HOME/profiles/tui/node_modules/@huiliyi37/dsh-tianshu-tui"

echo "=== installed TUI version / patch state ==="
node -e "console.log('tui version:', require('$TUI_DIR/package.json').version)"
node /root/patch-tui-status-panel.mjs "$TUI_DIR/lib/index.js" --check 2>&1 | tail -3

echo
echo "=== drive TUI ==="
rm -f /tmp/tui-in /tmp/tui-out.raw
mkfifo /tmp/tui-in
(
  sleep 25
  printf '/do-config\r'
  sleep 12
  printf '/status\r'
  sleep 14
  printf '\x03'
  sleep 2
) > /tmp/tui-in 2>/dev/null &
FEEDER=$!

cd /root
TERM=xterm-256color timeout 100 script -q -c "stty rows 45 cols 130 2>/dev/null; dsh --profile tui" /tmp/tui-out.raw < /tmp/tui-in > /dev/null 2>&1
echo "pty exit=$?"
wait $FEEDER 2>/dev/null
kill $FEEDER 2>/dev/null

echo "raw bytes: $(wc -c < /tmp/tui-out.raw 2>/dev/null)"

clean() { sed -r 's/\x1B\[[0-9;?]*[a-zA-Z]//g; s/\x1B\][^\x07]*\x07//g; s/\x1B[()][A-Z0-9]//g; s/\x1B[>=]//g' "$1" | tr '\r' '\n' | grep -v '^[[:space:]]*$'; }

echo
echo "=== markers in cleaned stream ==="
for m in 'do-config' '循环' 'autoContinue' 'modelFallback' '自动继续' '模型自动切换' 'loop'; do
  n=$(clean /tmp/tui-out.raw | grep -c -- "$m" 2>/dev/null || true)
  echo "  '$m' => ${n:-0}"
done

echo
echo "=== cleaned stream (tail 90) ==="
clean /tmp/tui-out.raw | tail -90
echo "=== done ==="
