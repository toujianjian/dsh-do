#!/usr/bin/env bash
# Run every Tier-1 suite and leave a machine-readable capture in /tmp/all.out.
bash /root/brute/run-all.sh > /tmp/all.out 2>&1
echo "run-all exit=$?"
grep -E '^(BRUTE_|-----|node )' /tmp/all.out | cut -c1-160
