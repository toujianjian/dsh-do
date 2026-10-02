#!/usr/bin/env bash
# 用新版 dsh-do 重新装配指定 profile，并重打 TUI 状态栏补丁。
#
#   bash /root/redeploy.sh <profile> <dsh-ver> <tui-ver> <tarball>
#
# tarball 路径每次都换新的（如 /root/dsh-do-fix1.tgz）：pnpm 按「版本号 + spec」
# 命中缓存，同一个路径重装会静默不更新。
set -uo pipefail
PROFILE="${1:?usage: redeploy.sh <profile> <dsh-ver> <tui-ver> <tarball>}"
DSH_VER="${2:?}"
TUI_VER="${3:?}"
TARBALL="${4:?}"

bash /root/matrix-version.sh "$DSH_VER" "$TUI_VER" "$PROFILE" "$TARBALL"

echo
echo "=== 重打 TUI 状态栏补丁 ==="
bash /root/apply-patch-container.sh "/root/.dsh/profiles/$PROFILE/node_modules/@huiliyi37/dsh-tianshu-tui/lib/index.js"

echo
echo "=== 确认安装副本就是新构建 ==="
node -e "
const fs=require('fs'),c=require('crypto');
const p='/root/.dsh/profiles/$PROFILE/node_modules/dsh-do/lib/index.js';
console.log('installed lib sha256:', c.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase().slice(0,16));
console.log('has session-log reader:', fs.readFileSync(p,'utf8').includes('snapshotEvents'));
"
echo "=== redeploy done: $PROFILE ==="
