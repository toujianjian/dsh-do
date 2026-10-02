#!/usr/bin/env node
// 打印若干根目录下指定包的解析版本，并检查 hmr 是否具备 registerConfig。
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const [root, ...pkgs] = process.argv.slice(2)
for (const pkg of pkgs) {
	const pj = join(root, 'node_modules', pkg, 'package.json')
	if (!existsSync(pj)) {
		console.log(`${pkg}: (absent)`)
		continue
	}
	const version = JSON.parse(readFileSync(pj, 'utf8')).version
	let extra = ''
	if (pkg.endsWith('cordis-plugin-hmr')) {
		const lib = join(root, 'node_modules', pkg, 'lib', 'index.js')
		extra = existsSync(lib) && readFileSync(lib, 'utf8').includes('registerConfig') ? ' [has registerConfig]' : ' [NO registerConfig]'
	}
	console.log(`${pkg}: ${version}${extra}`)
}
