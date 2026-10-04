#!/usr/bin/env bash
# 把这次 TUI 验证的证据全部落盘：检查点、会话日志里的循环轮次、面板渲染。
set -uo pipefail
export DSH_HOME=/root/.dsh

echo "=== 1) 检查点文件 ==="
ls -la "$DSH_HOME/loops/" 2>/dev/null || echo "(no loops dir)"
for f in "$DSH_HOME"/loops/*; do
  [ -f "$f" ] || continue
  echo "### $f"
  cat "$f"
  echo
done

echo
echo "=== 2) 会话目录 ==="
find "$DSH_HOME/sessions" -maxdepth 3 -type d 2>/dev/null | head -10
echo "--- session 文件 ---"
find "$DSH_HOME/sessions" -name '*.zstd' 2>/dev/null | head -10

echo
echo "=== 3) 录制里所有 loop 相关行 ==="
grep -n -i 'loop' /tmp/tui-tui.clean.txt | head -40

echo
echo "=== 4) 面板循环段（全部出现）==="
grep -n -A5 '◆ 循环' /tmp/tui-tui.clean.txt | head -40

echo
echo "=== 5) 首次 bare /loop（状态查询）的输出 ==="
sed -n '1,140p' /tmp/tui-tui.clean.txt | grep -n -B2 -A6 'Status:' | head -40
