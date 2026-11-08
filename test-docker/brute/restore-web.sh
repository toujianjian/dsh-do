#!/usr/bin/env bash
set -u
pkill -f "dsh --profile web020" 2>/dev/null
pkill -f mock-llm-messages 2>/dev/null
sleep 0.5
P=/root/.dsh/profiles/web020/node_modules/dsh-do/lib
B=/root/backup-dsh-do-lib-web020
rm -rf "$P" && cp -a "$B" "$P"
echo "restored profile lib: $(md5sum "$P/index.js" | cut -d' ' -f1)"
rm -rf /work/dsh-do-lib
echo "procs left: $(pgrep -fc 'dsh --profile web020' || true)"
ls -la /root/.dsh/settings.yaml 2>/dev/null || echo "settings.yaml still absent"