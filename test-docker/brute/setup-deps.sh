#!/usr/bin/env bash
# rc.6 pins for the unbundled lib/types build. The list is deliberately the
# full peer set: npm resolves dsh-settings' own imports from this directory,
# so a lone dsh-settings install cannot even load.
set -e
mkdir -p /root/brute-deps && cd /root/brute-deps
cat > package.json <<'JSON'
{ "name": "brute-deps", "private": true, "type": "module", "dependencies": {
  "@deepseek-ai/dsh-settings": "0.1.0-rc.6",
  "@deepseek-ai/dsh-llm": "0.1.0-rc.6",
  "@deepseek-ai/dsh-session": "0.1.0-rc.6",
  "@deepseek-ai/dsh-tools": "0.1.0-rc.6",
  "@deepseek-ai/dsh-agent": "0.1.0-rc.6",
  "@deepseek-ai/cordis": "4.0.1",
  "@deepseek-ai/schemastery": "3.18.1"
} }
JSON
timeout 240 npm install --legacy-peer-deps --no-audit --no-fund 2>&1 | tail -5
node --input-type=module -e "import('@deepseek-ai/dsh-settings').then(m=>console.log('settings exports:',Object.keys(m).join(',')))"