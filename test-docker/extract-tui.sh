#!/usr/bin/env bash
# 从上一次的 pty 录制里把「循环」「◆」「状态面板」相关上下文捞出来。
set -uo pipefail
RAW=/tmp/tui-out.raw

clean() { sed -r 's/\x1B\[[0-9;?]*[a-zA-Z]//g; s/\x1B\][^\x07]*\x07//g; s/\x1B[()][A-Z0-9]//g; s/\x1B[>=]//g' "$RAW" | tr '\r' '\n' | grep -v '^[[:space:]]*$'; }

clean > /tmp/tui-clean.txt
echo "clean lines: $(wc -l < /tmp/tui-clean.txt)"

echo
echo "=== '◆' occurrences ==="
grep -n '◆' /tmp/tui-clean.txt | head -20 || echo "(none)"

echo
echo "=== lines containing 循环 ==="
grep -n '循环' /tmp/tui-clean.txt | head -20 || echo "(none)"

echo
echo "=== context around first 循环 ==="
grep -n -B6 -A18 '循环' /tmp/tui-clean.txt | head -60

echo
echo "=== status panel area (around 状态/投影/域) ==="
grep -n -B3 -A25 '投影' /tmp/tui-clean.txt | head -70

echo
echo "=== do-config output block ==="
grep -n -B4 -A24 'do-config' /tmp/tui-clean.txt | head -70
echo "=== done ==="
