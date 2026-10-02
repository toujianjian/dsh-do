#!/usr/bin/env bash
# Web 组合的版本矩阵装配：为指定 dsh 版本建一个 web profile（dsh-base + dsh-web-app + dsh-do）。
#
#   bash /root/matrix-web.sh <dsh-ver> <profile-name> [tarball]
#
# 与 matrix-version.sh 的差别只在 bundle 清单：TUI 版装 dsh-tianshu-tui，这里装 dsh-web-app。
# TUI 那个脚本验证的是「组合接纳 id: do」与「终端交互」；Web 这一侧要验的是另一套面：
# Client slot 装配、/plugins/dsh-do/client.js 能否出厂、/dsh-do/settings 路由是否就位。
set -uo pipefail

DSH_VER="${1:?usage: matrix-web.sh <dsh-ver> <profile> [tarball]}"
PROFILE="${2:?}"
TARBALL="${3:-/root/dsh-do-0.1.0.tgz}"

export DSH_HOME=/root/.dsh
DIR="$DSH_HOME/profiles/$PROFILE"

echo "############ matrix-web: dsh=$DSH_VER profile=$PROFILE ############"

echo
echo "=== 1) 全局 dsh CLI -> $DSH_VER ==="
npm i -g "@deepseek-ai/dsh@$DSH_VER" --no-fund --no-audit 2>&1 | tail -2
echo "dsh: $(dsh --version 2>&1 | tail -1)"
echo "pnpm: $(pnpm --version 2>&1 | tail -1)"

echo
echo "=== 2) 建 profile $DIR ==="
rm -rf "$DIR"
mkdir -p "$DIR"
cd "$DIR"

# 同 matrix-version.sh：只有 0.1.0-rc.8 需要 hmr 1.0.17 的钉子。
EXTRA_EXCLUDES=""
EXTRA_OVERRIDES=""
if [ "$DSH_VER" = "0.1.0-rc.8" ]; then
  EXTRA_EXCLUDES="  - '@deepseek-ai/cordis-plugin-hmr@1.0.17'"
  EXTRA_OVERRIDES="
overrides:
  '@deepseek-ai/cordis-plugin-hmr': 1.0.17"
fi

cat > pnpm-workspace.yaml <<EOF
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
  sharp: false
  '@parcel/watcher': false

minimumReleaseAgeExclude:
  - '@deepseek-ai/dsh-web-app@$DSH_VER'
$EXTRA_EXCLUDES$EXTRA_OVERRIDES
EOF

cat > package.json <<EOF
{
  "name": "dsh-profile-$PROFILE",
  "private": true,
  "version": "0.0.0",
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-do"
      ]
    }
  },
  "dependencies": {
    "@deepseek-ai/dsh-base": "$DSH_VER",
    "@deepseek-ai/dsh-web-app": "$DSH_VER",
    "dsh-do": "file:$TARBALL"
  }
}
EOF

echo
echo "=== 3) pnpm install ==="
pnpm install 2>&1 | tail -12

echo
echo "=== 4) 解析到的版本 ==="
node /root/vercmp.mjs "$DIR" \
  '@deepseek-ai/dsh-base' \
  '@deepseek-ai/dsh-web-app' \
  '@deepseek-ai/dsh-subprocess-local' \
  '@deepseek-ai/dsh-session-projection' \
  'dsh-do' 2>&1

echo
echo "=== 5) dsh-do 产物身份 ==="
node -e "
const fs=require('fs'),c=require('crypto');
const p='$DIR/node_modules/dsh-do/lib/index.js';
if(!fs.existsSync(p)){console.log('!! dsh-do/lib/index.js MISSING');process.exit(0)}
console.log('lib/index.js sha256:', c.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase().slice(0,16));
"

echo
echo "=== 6) 组合检查：dsh 是否接纳 id: do 这一行 ==="
dsh --profile "$PROFILE" --dump-config > "/tmp/dump-$PROFILE.txt" 2>&1
echo "dump exit=$?"
echo "--- 'id: do' 行 ---"
grep -n 'id: do' "/tmp/dump-$PROFILE.txt" || echo "!! 没有 id: do 行"
echo "--- 跳过/不兼容 行 ---"
grep -n 'skipping\|incompatible' "/tmp/dump-$PROFILE.txt" | head -3 || echo "(none)"
echo "--- 行数 ---"
wc -l < "/tmp/dump-$PROFILE.txt"
echo "############ done: $PROFILE ############"
