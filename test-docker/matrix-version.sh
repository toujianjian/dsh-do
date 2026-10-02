#!/usr/bin/env bash
# 参数化的版本矩阵装配：为指定的 dsh / tui 版本建一个独立 profile 并验证 dsh-do 是否被组合接纳。
#
#   bash /root/matrix-version.sh <dsh-ver> <tui-ver> <profile-name> [tarball]
#
# 例：bash /root/matrix-version.sh 0.1.5-rc.3 0.1.2-rc.31 v015
#
# 与旧脚本的差别：这里同时把**全局 dsh CLI** 切到目标版本（profile 的 @deepseek-ai/* 全部
# 由 profile 的 dependencies 精确钉住），因此每个 profile 都是自洽的一套，不会互相污染。
set -uo pipefail

DSH_VER="${1:?usage: matrix-version.sh <dsh-ver> <tui-ver> <profile> [tarball]}"
TUI_VER="${2:?}"
PROFILE="${3:?}"
TARBALL="${4:-/root/dsh-do-0.1.0.tgz}"

export DSH_HOME=/root/.dsh
DIR="$DSH_HOME/profiles/$PROFILE"

echo "############ matrix: dsh=$DSH_VER tui=$TUI_VER profile=$PROFILE ############"

echo
echo "=== 1) 全局 dsh CLI -> $DSH_VER ==="
npm i -g "@deepseek-ai/dsh@$DSH_VER" --no-fund --no-audit 2>&1 | tail -3
echo "dsh: $(dsh --version 2>&1 | tail -1)"
echo "pnpm: $(pnpm --version 2>&1 | tail -1)"

echo
echo "=== 2) 建 profile $DIR ==="
rm -rf "$DIR"
mkdir -p "$DIR"
cd "$DIR"

# dsh 0.1.0-rc.8 的 dsh-app-boot 会调 cordis-plugin-hmr 的 registerConfig，而全新安装解析到的
# 1.0.19 已删除该 API（本机在用的是 1.0.17）。0.1.5-rc.3 起 dsh-base 自己精确依赖 1.0.17，
# hmr 甚至不再出现在依赖树里，所以只有 rc.8 需要这根钉子。
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
  - '@huiliyi37/dsh-tianshu-tui@$TUI_VER'
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
        "@huiliyi37/dsh-tianshu-tui",
        "dsh-do"
      ]
    }
  },
  "dependencies": {
    "@deepseek-ai/dsh-base": "$DSH_VER",
    "@huiliyi37/dsh-tianshu-tui": "$TUI_VER",
    "dsh-do": "file:$TARBALL"
  }
}
EOF

echo
echo "=== 3) pnpm install ==="
pnpm install 2>&1 | tail -18

echo
echo "=== 4) 解析到的版本 ==="
node /root/vercmp.mjs "$DIR" \
  '@deepseek-ai/dsh-base' \
  '@deepseek-ai/cordis-plugin-hmr' \
  '@deepseek-ai/dsh-subprocess-local' \
  '@deepseek-ai/dsh-session-projection' \
  '@huiliyi37/dsh-tianshu-tui' \
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
echo "--- dsh-do 相关行 ---"
grep -n 'dsh-do' "/tmp/dump-$PROFILE.txt" | head -8
echo "--- 行数 ---"
wc -l < "/tmp/dump-$PROFILE.txt"

echo
echo "=== 7) windowsHide 现状（黑窗补丁已撤销，此项应原生为 true） ==="
node -e "
const fs=require('fs');
const p='$DIR/node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js';
if(!fs.existsSync(p)){console.log('(subprocess-local 不在 profile 里，由全局 dsh 提供)');process.exit(0)}
const s=fs.readFileSync(p,'utf8');
console.log('windowsHide present:', s.includes('windowsHide'));
"
echo "############ done: $PROFILE ############"
