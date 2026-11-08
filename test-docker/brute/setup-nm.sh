#!/usr/bin/env bash
# Build /root/brute/node_modules: the working profile's tree, with exactly one
# package overridden by the rc.6 install from /root/brute-deps.
#
# Why: lib/types/*.js (the unbundled build) imports deepEqualJson /
# settingsNamespace / installSettingsSection from @deepseek-ai/dsh-settings.
# Those exports exist in 0.1.0-rc.6 but are gone in 0.2.0-rc.2, while the
# published lib/index.js bundle inlines them and therefore runs on either.
set -e
B=/root/brute/node_modules
V=/root/.dsh/profiles/v020/node_modules
rm -rf "$B" && mkdir -p "$B"
for entry in "$V"/* "$V"/.[!.]*; do
	name=$(basename "$entry")
	[ "$name" = "@deepseek-ai" ] && continue
	ln -sfn "$entry" "$B/$name"
done
mkdir -p "$B/@deepseek-ai"
for entry in "$V"/@deepseek-ai/*; do
	name=$(basename "$entry")
	[ "$name" = "dsh-settings" ] && continue
	ln -sfn "$entry" "$B/@deepseek-ai/$name"
done
ln -sfn /root/brute-deps/node_modules/@deepseek-ai/dsh-settings "$B/@deepseek-ai/dsh-settings"

cd /root/brute
node --input-type=module -e "import('@deepseek-ai/dsh-settings').then((m) => console.log('settings exports:', Object.keys(m).join(',')))"
node --input-type=module -e "import('@deepseek-ai/dsh-llm').then((m) => console.log('dsh-llm ok, exports =', Object.keys(m).length))"