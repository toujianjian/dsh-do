#!/usr/bin/env bash
# 在真实 TTY 里跑某个 profile：起循环 → /status → 抓「◆ 循环」段。
# 该段只在 loop 视图非空时渲染，所以必须先 /loop 起一个循环。
#
#   bash /root/verify-tui-profile.sh <profile> [objective]
#
# 建议跑之前先断网，避免 TUI 自我升级把 profile 弄坏：
#   docker network disconnect bridge dsh-env
set -uo pipefail
export DSH_HOME=/root/.dsh
PROFILE="${1:?usage: verify-tui-profile.sh <profile> [objective]}"
OBJECTIVE="${2:-验证状态栏循环段}"
RAW="/tmp/tui-$PROFILE.raw"
CLEAN="/tmp/tui-$PROFILE.clean.txt"
FIFO="/tmp/tui-$PROFILE.in"

echo "############ TTY verify: profile=$PROFILE ############"
echo "tui version: $(node -e "console.log(require('$DSH_HOME/profiles/$PROFILE/node_modules/@huiliyi37/dsh-tianshu-tui/package.json').version)" 2>/dev/null || echo '?')"

rm -f "$FIFO" "$RAW"
mkfifo "$FIFO"
(
  sleep 28
  printf '/loop\r'
  sleep 8
  printf '/loop %s\r' "$OBJECTIVE"
  sleep 14
  printf '/status\r'
  sleep 16
  printf '\x03'
  sleep 2
) > "$FIFO" 2>/dev/null &
FEEDER=$!

cd /root
TERM=xterm-256color timeout 120 script -q -c "stty rows 50 cols 130 2>/dev/null; dsh --profile $PROFILE" "$RAW" < "$FIFO" > /dev/null 2>&1
echo "pty exit=$? (124 = 超时收割，非崩溃)"
wait $FEEDER 2>/dev/null
kill $FEEDER 2>/dev/null

clean() { sed -r 's/\x1B\[[0-9;?]*[a-zA-Z]//g; s/\x1B\][^\x07]*\x07//g; s/\x1B[()][A-Z0-9]//g; s/\x1B[>=]//g' "$RAW" | tr '\r' '\n' | grep -v '^[[:space:]]*$'; }
clean > "$CLEAN"
echo "raw bytes: $(wc -c < "$RAW"), clean lines: $(wc -l < "$CLEAN")"

echo
echo "=== 启动期错误（插件装载失败会在这里现形）==="
grep -n -i 'failed to load\|Error:\|cannot find\|ERR_\|not a function' "$CLEAN" | head -12 || echo "(无)"

echo
echo "=== '◆' 出现位置 ==="
grep -n '◆' "$CLEAN" | head -12 || echo "(none)"

echo
echo "=== /loop 结果 ==="
grep -n -A8 "/loop $OBJECTIVE" "$CLEAN" | head -14

echo
echo "=== /status 面板尾部 ==="
tail -25 "$CLEAN"
echo "############ done: $PROFILE ############"
