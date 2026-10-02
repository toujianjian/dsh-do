#!/usr/bin/env bash
# 按本机 tui profile 的真实配置重建（pnpm 11.6.0 + nodeLinker: hoisted）。
set -uo pipefail
export DSH_HOME=/root/.dsh
PROFILE_DIR="$DSH_HOME/profiles/tui"

echo "=== install pnpm@11.6.0 (match host) ==="
npm i -g pnpm@11.6.0 --no-fund --no-audit 2>&1 | tail -2
pnpm --version

cd "$PROFILE_DIR"

# 本机 tui profile 的 pnpm-workspace.yaml，逐字复刻
rm -f pnpm-workspace.yaml
cat > pnpm-workspace.yaml <<'EOF'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
minimumReleaseAgeExclude:
  - '@huiliyi37/dsh-tianshu-tui@0.1.1-rc.6'
EOF

rm -rf node_modules pnpm-lock.yaml
cat > package.json <<'EOF'
{
  "name": "dsh-profile-tui",
  "private": true,
  "version": "0.0.0",
  "dsh": { "profile": { "bundles": [] } }
}
EOF

echo
echo "=== add all three bundles ==="
dsh plugin --profile tui add \
  "@deepseek-ai/dsh-base@0.1.0-rc.8" \
  "@huiliyi37/dsh-tianshu-tui@0.1.1-rc.6" \
  "github:toujianjian/dsh-do" 2>&1 | tail -14

echo
echo "=== package.json ==="
cat package.json

echo
echo "=== dsh-do identity ==="
node -e "const fs=require('fs'),c=require('crypto');const p=process.cwd()+'/node_modules/dsh-do/lib/index.js';console.log('sha256:',c.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase().slice(0,16));"
echo "=== done ==="
