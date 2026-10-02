#!/usr/bin/env bash
# TUI 会自我升级到 latest（1.0.0-rc.2），与 dsh 0.1.0-rc.8 不兼容。
# 这里用 pnpm overrides 钉回本机在用的 0.1.1-rc.6，并重新打状态栏补丁。
set -uo pipefail
export DSH_HOME=/root/.dsh
TUI_DIR="$DSH_HOME/profiles/tui/node_modules/@huiliyi37/dsh-tianshu-tui"
cd "$DSH_HOME/profiles/tui"

cat > pnpm-workspace.yaml <<'EOF'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false

allowBuilds:
  node-pty: false
  protobufjs: false
  koffi: false
  '@google/genai': false
  '@deepseek-ai/dsh-subprocess-local': false
  cpu-features: false
  ssh2: false

minimumReleaseAgeExclude:
  - '@huiliyi37/dsh-tianshu-tui@0.1.1-rc.6'
  - '@deepseek-ai/cordis-plugin-hmr@1.0.17'

overrides:
  '@deepseek-ai/cordis-plugin-hmr': 1.0.17
  '@huiliyi37/dsh-tianshu-tui': 0.1.1-rc.6
EOF

cat > package.json <<'EOF'
{
  "name": "dsh-profile-tui",
  "private": true,
  "version": "0.0.0",
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@huiliyi37/dsh-tianshu-tui",
        "dsh-do"
      ]
    }
  },
  "dependencies": {
    "@deepseek-ai/dsh-base": "0.1.0-rc.8",
    "@huiliyi37/dsh-tianshu-tui": "0.1.1-rc.6",
    "dsh-do": "github:toujianjian/dsh-do"
  }
}
EOF

echo "=== pnpm install (tui pinned 0.1.1-rc.6, hmr 1.0.17) ==="
pnpm install 2>&1 | tail -8

echo
echo "=== resolved versions ==="
node -e "console.log('tui:', require('$TUI_DIR/package.json').version)"
node /root/vercmp.mjs "$DSH_HOME/profiles/tui" '@deepseek-ai/cordis-plugin-hmr' 'dsh-do'
echo "tui lib sha256: $(node -e "const fs=require('fs'),c=require('crypto');console.log(c.createHash('sha256').update(fs.readFileSync('$TUI_DIR/lib/index.js')).digest('hex').toUpperCase().slice(0,16))")"

echo
echo "=== re-apply status panel patch ==="
node /root/patch-tui-status-panel.mjs "$TUI_DIR/lib/index.js" 2>&1 | tail -3
node /root/patch-tui-status-panel.mjs "$TUI_DIR/lib/index.js" --check 2>&1 | tail -3
echo "=== done ==="
