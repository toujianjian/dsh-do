#!/usr/bin/env bash
# 把我为测试改动过的容器状态恢复原样：凭证文件、全局 dsh CLI 版本。
# （mock 相关文件留在 /root 下，后续还能复用。）
set -uo pipefail
export DSH_HOME=/root/.dsh

echo "=== 1) 恢复凭证文件 ==="
BAK=$(ls -t /root/credentials.yaml.bak-* 2>/dev/null | head -1)
if [ -n "$BAK" ]; then
  cp "$BAK" "$DSH_HOME/.credentials.yaml"
  chmod 600 "$DSH_HOME/.credentials.yaml"
  echo "已从 $BAK 恢复"
  head -2 "$DSH_HOME/.credentials.yaml"
else
  echo "(没找到备份)"
fi

echo
echo "=== 2) 全局 CLI -> 0.2.0-rc.2（我接手时的版本）==="
npm i -g '@deepseek-ai/dsh@0.2.0-rc.2' --no-fund --no-audit 2>&1 | tail -2
echo "dsh now: $(dsh --version 2>&1 | tail -1)"

echo
echo "=== 3) 复核 ==="
ls -la "$DSH_HOME/.credentials.yaml"
ls -1 /root/mock-*.mjs /root/mock-*.yml /root/verify-loop-multiround.sh 2>/dev/null
