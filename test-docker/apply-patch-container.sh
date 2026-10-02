#!/usr/bin/env bash
# 把新版 TUI 状态栏补丁应用到指定 bundle，并自检幂等与语法。
set -uo pipefail
TUI="${1:-/root/.dsh/profiles/tui/node_modules/@huiliyi37/dsh-tianshu-tui/lib/index.js}"

echo "=== 1) check (旧版补丁 → 应报 NOT patched，升级待做) ==="
node /root/patch-tui-status-panel.mjs "$TUI" --check

echo "=== 2) apply ==="
node /root/patch-tui-status-panel.mjs "$TUI"

echo "=== 3) check again (应报 patched) ==="
node /root/patch-tui-status-panel.mjs "$TUI" --check

echo "=== 4) apply again (应无改动) ==="
node /root/patch-tui-status-panel.mjs "$TUI"

echo "=== 5) duplicates + syntax ==="
for m in 'function projectLoopSection' 'const LOOP_TITLE' 'loop: this.ctx.reflect' 'projectionCache?.loop'; do
  printf '  %-32s => %s\n' "$m" "$(grep -c -- "$m" "$TUI")"
done
node --check "$TUI" && echo "syntax OK"
echo "=== done ==="
