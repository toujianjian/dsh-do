#!/usr/bin/env bash
# Run the Tier-1 brute-force suites inside the container.
# Usage: bash /root/brute/run-all.sh [suite ...]
set -u
cd /root/brute || exit 1
echo "node $(node --version) · $(uname -s)"
suites=("$@")
if [ ${#suites[@]} -eq 0 ]; then
	suites=(run-pure.mjs run-store.mjs run-http.mjs)
fi
rc=0
for suite in "${suites[@]}"; do
	echo "===== ${suite} ====="
	timeout -s KILL 900 node "${suite}" 2>&1 | tail -n 80
	code=${PIPESTATUS[0]}
	echo "----- ${suite} exit=${code}"
	[ "${code}" -ne 0 ] && rc=1
done
exit "${rc}"
