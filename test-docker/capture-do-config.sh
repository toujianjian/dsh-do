#!/usr/bin/env bash
# 在真实 TUI 里抓 /do-config 的渲染：验证盒子是矩形、值列对齐、ANSI 真的透传。
#
#   bash capture-do-config.sh [profile]     默认 tui（dsh 0.1.0-rc.8）
#   例：bash capture-do-config.sh v020      （dsh 0.2.0-rc.2 + tui 1.0.0-rc.2）
set -uo pipefail
export DSH_HOME=/root/.dsh
PROFILE="${1:-tui}"
RAW=/tmp/dc-$PROFILE.raw
CLEAN=/tmp/dc-$PROFILE.txt
FIFO=/tmp/dc-$PROFILE.in
rm -f "$FIFO" "$RAW"

mkfifo "$FIFO"
(
  sleep 26
  # 有些 TUI 版本（如 1.0.0-rc.2）首启会弹「设置 API Key」模态，先按 Esc 关掉，
  # 否则后面敲的命令会被模态吃掉。
  printf '\x1b'
  sleep 2
  printf '/do-config\r'
  sleep 6
  printf '\x03'
  sleep 2
) > "$FIFO" 2>/dev/null &
FEEDER=$!

cd /root
TERM=xterm-256color timeout 60 script -q -c "stty rows 50 cols 130 2>/dev/null; dsh --profile $PROFILE" "$RAW" < "$FIFO" > /dev/null 2>&1
echo "profile=$PROFILE pty exit=$? (124=超时收割)"
wait $FEEDER 2>/dev/null
kill $FEEDER 2>/dev/null

# 剥掉 ANSI 得到"用户看到的样子"
sed -r 's/\x1B\[[0-9;?]*[a-zA-Z]//g; s/\x1B\][^\x07]*\x07//g; s/\x1B[()][A-Z0-9]//g; s/\x1B[>=]//g' "$RAW" | tr '\r' '\n' | grep -v '^[[:space:]]*$' > "$CLEAN"

echo
echo "=== ANSI 属性序列是否真的发出（TUI 未吞掉）==="
node -e "
const s = require('fs').readFileSync('$RAW', 'utf8');
console.log('  ESC[1m (bold):', (s.match(/\x1b\[1m/g) || []).length);
console.log('  ESC[2m (dim) :', (s.match(/\x1b\[2m/g) || []).length);
"
echo
echo "=== 剥掉 ANSI 后的 /do-config（尾部 42 行）==="
tail -42 "$CLEAN"
