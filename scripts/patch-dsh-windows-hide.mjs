#!/usr/bin/env node
/**
 * patch-dsh-windows-hide.mjs — 让 DSH 在 Windows 上起子进程时不再闪黑窗。
 *
 * 背景：@deepseek-ai/dsh-subprocess-local 的 spawnSubprocess() 在 0.1.0-rc.8 里
 * 调 spawn() 时只传了 cwd/env/stdio/detached，**没有 windowsHide**。DSH 自己通常是
 * 无控制台启动的（例如 dsh web 是 detached 起来的），于是每次起 pwsh.exe / bash 都会
 * 让 Windows 新分配一个控制台窗口 —— 就是那个一闪而过的黑窗。
 *
 * 上游 0.2.0-rc.2 已自带 `windowsHide: true`，所以升级到该版本后本脚本不再需要。
 *
 * 用法：
 *   node scripts/patch-dsh-windows-hide.mjs <目录或文件> [--check]
 *   # 目录会递归查找所有 dsh-subprocess-local/lib/index.js
 *   # --check 只检查不写入
 */
import { readFileSync, writeFileSync, readdirSync, statSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

const TARGET_SUFFIX = join('dsh-subprocess-local', 'lib', 'index.js')
const NEEDLE = '\t\tdetached: platform !== "win32"\n\t});'
const REPLACEMENT = '\t\tdetached: platform !== "win32",\n\t\twindowsHide: true\n\t});'
const MARKER = 'windowsHide: true'
/** 只有这些目录名才值得往下走，避免在整个 node_modules 里乱翻。 */
const DESCEND = new Set(['node_modules', 'lib', 'dist'])

/** @param {string} root @returns {string[]} */
function findTargets(root) {
	const out = []
	const seen = new Set()
	const walk = (dir, depth) => {
		if (depth > 12) return
		// pnpm 大量使用符号链接，Dirent 对链接不报 isDirectory，必须解析真实路径；seen 防环。
		let real
		try {
			real = realpathSync(dir)
		} catch {
			return
		}
		if (seen.has(real)) return
		seen.add(real)
		let entries
		try {
			entries = readdirSync(dir, { withFileTypes: true })
		} catch {
			return
		}
		for (const entry of entries) {
			const full = join(dir, entry.name)
			if (full.endsWith(TARGET_SUFFIX)) {
				out.push(full)
				continue
			}
			const descend = DESCEND.has(entry.name) || entry.name.startsWith('@') || entry.name.startsWith('dsh-') || entry.name.startsWith('.')
			if (!descend) continue
			let stat
			try {
				stat = statSync(full)
			} catch {
				continue
			}
			if (stat.isDirectory()) walk(full, depth + 1)
		}
	}
	const stat = statSync(root)
	if (stat.isFile()) return root.endsWith(TARGET_SUFFIX) ? [root] : []
	walk(root, 0)
	return out
}

const [rawRoot, ...flags] = process.argv.slice(2)
const check = flags.includes('--check')
if (rawRoot === undefined) {
	console.error('usage: node scripts/patch-dsh-windows-hide.mjs <dir-or-file> [--check]')
	process.exit(2)
}

const targets = findTargets(rawRoot)
if (targets.length === 0) {
	console.log(`no dsh-subprocess-local/lib/index.js found under ${rawRoot}`)
	process.exit(1)
}

let patched = 0
let already = 0
let failed = 0
for (const file of targets) {
	const source = readFileSync(file, 'utf8')
	if (source.includes(MARKER)) {
		already += 1
		console.log(`already : ${file}`)
		continue
	}
	if (!source.includes(NEEDLE)) {
		failed += 1
		console.log(`SKIP    : ${file} (spawn options shape not recognised)`)
		continue
	}
	const next = source.replace(NEEDLE, REPLACEMENT)
	if (check) {
		patched += 1
		console.log(`would patch: ${file}`)
		continue
	}
	writeFileSync(file, next, 'utf8')
	patched += 1
	console.log(`patched : ${file}`)
}

console.log(`\n${check ? 'CHECK' : 'APPLIED'}: ${patched} ${check ? 'to patch' : 'patched'}, ${already} already, ${failed} skipped`)
if (!check && patched > 0) console.log('restart the harness for the change to take effect')
process.exit(failed > 0 && patched === 0 ? 1 : 0)
