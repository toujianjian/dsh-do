#!/usr/bin/env bash
# 一次跑完剩下的版本矩阵（顺序执行：matrix-version.sh 会切换全局 dsh CLI，
# 并行会互相踩）。
#
#   bash /root/matrix-all.sh [tarball]
set -uo pipefail
TARBALL="${1:-/root/dsh-do-fix1.tgz}"

echo "@@@@@@@@@@@@@@ C: dsh 0.2.0-rc.2 + tui 1.0.0-rc.2 @@@@@@@@@@@@@@"
bash /root/redeploy.sh v020 0.2.0-rc.2 1.0.0-rc.2 "$TARBALL"
echo
echo "@@@@@@@@@@@@@@ D: dsh 0.1.7-rc.2 + tui 0.1.2-rc.31 @@@@@@@@@@@@@@"
bash /root/redeploy.sh v017 0.1.7-rc.2 0.1.2-rc.31 "$TARBALL"
echo
echo "@@@@@@@@@@@@@@ matrix-all done @@@@@@@@@@@@@@"
