#!/usr/bin/env bash
# 为 tui profile 的 TTY 验证做准备：
#   1) 备份并清除凭证（0.1.0-rc.8 要求 version 是字符串，0.2.0 写的数字 1 会让
#      dsh-credentials-local 抛 TypeError，把整个 profile 启动打掉）
#   2) 全局 dsh CLI 切到 0.1.0-rc.8（profile 的依赖是这一套；CLI 不匹配会加载失败）
# 需要网络。跑完 TUI 前记得断网，见 README。
set -uo pipefail
export DSH_HOME=/root/.dsh

echo "=== 1) 凭证 ==="
if [ -f "$DSH_HOME/.credentials.yaml" ]; then
  BAK="/root/credentials.yaml.bak-$(date +%s)"
  cp "$DSH_HOME/.credentials.yaml" "$BAK"
  echo "已备份到 $BAK"
  head -3 "$BAK"
fi
rm -f "$DSH_HOME/.credentials.yaml"
echo "已清除 $DSH_HOME/.credentials.yaml"

echo
echo "=== 2) 全局 CLI -> 0.1.0-rc.8 ==="
npm i -g '@deepseek-ai/dsh@0.1.0-rc.8' --no-fund --no-audit 2>&1 | tail -3
echo "dsh now: $(dsh --version 2>&1 | tail -1)"
echo "pnpm: $(pnpm --version)"

echo
echo "=== 3) tui profile 版本复核 ==="
PROFILE_DIR="$DSH_HOME/profiles/tui" node -e "
const fs=require('fs');
const d=process.env.PROFILE_DIR;
for (const p of ['@deepseek-ai/dsh-base','@huiliyi37/dsh-tianshu-tui','dsh-do']) {
  try { console.log('  '+p+' = '+JSON.parse(fs.readFileSync(d+'/node_modules/'+p+'/package.json','utf8')).version) } catch(e) { console.log('  '+p+' = -') }
}
"
