#!/usr/bin/env bash
# 探查 0.2.0-rc.2 profile 的版本闸门状态：豁免有没有生效、dsh-do 是否被接纳。
set -uo pipefail
export DSH_HOME=/root/.dsh
P=v020

{
  echo "=== dsh --version ==="
  dsh --version

  echo
  echo "=== --dump-config ==="
  dsh --profile "$P" --dump-config > /tmp/d020.txt 2>&1
  echo "dump exit=$?"

  echo
  echo "=== 'id: do' 行 ==="
  grep -n 'id: do' /tmp/d020.txt || echo "(absent)"

  echo
  echo "=== 跳过 / 不兼容 / 豁免 相关行 ==="
  grep -n 'skipping\|incompatible\|exemption' /tmp/d020.txt | head -6 || echo "(none)"

  echo
  echo "=== dsh-do 相关行 ==="
  grep -n 'dsh-do' /tmp/d020.txt | head -6 || echo "(none)"

  echo
  echo "=== profile package.json ==="
  cat "/root/.dsh/profiles/$P/package.json"

  echo
  echo "=== profile 目录里有没有豁免记录 ==="
  ls -la "/root/.dsh/profiles/$P/" | head -20
  echo "--- 全盘搜 exemption/allowVersion 痕迹 ---"
  grep -rl 'dsh-do' "$DSH_HOME" --include='*.json' --include='*.yaml' --include='*.yml' 2>/dev/null | grep -v node_modules | head -10
} > /tmp/probe020.txt 2>&1

echo "wrote /tmp/probe020.txt ($(wc -c < /tmp/probe020.txt) bytes)"
