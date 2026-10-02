#!/usr/bin/env bash
# 宿主的 hosts 把 github.com 指到 127.0.0.1（容器里那是容器自身），
# 这里在容器内改回真实 IP，好让 `dsh plugin add github:...` 这条文档路径可测。
set -uo pipefail

GH_IP="${1:-20.205.243.166}"

sed -i '/[[:space:]]github\.com$/d' /etc/hosts
printf '%s github.com\n' "$GH_IP" >> /etc/hosts

echo "=== /etc/hosts github.com lines ==="
grep github /etc/hosts || true
echo "=== resolve ==="
getent hosts github.com
echo "=== curl github.com ==="
curl -sS -o /dev/null -w 'gh=%{http_code}\n' --max-time 20 https://github.com/ 2>&1 || echo "curl failed"
echo "=== git ls-remote ==="
GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/toujianjian/dsh-do.git HEAD 2>&1 | head -3
echo "=== done ==="
