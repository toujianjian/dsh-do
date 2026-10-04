/**
 * 从 TUI 录制里看 /do-config 列表区域的**原始字节**：SGR 到底发没发、发在哪。
 *
 *   node raw-sgr.mjs <raw 文件> [锚点字符串]
 */
import { readFileSync } from 'node:fs'

const file = process.argv[2]
const anchor = process.argv[3] ?? '◆ 循环'
const raw = readFileSync(file, 'utf8')

const at = raw.indexOf(anchor)
if (at < 0) {
  console.log(`找不到锚点 ${anchor}`)
  process.exit(1)
}

const from = Math.max(0, at - 200)
const to = Math.min(raw.length, at + 2600)
const slice = raw.slice(from, to)

// 把 ESC 显示成 <ESC>，CR 显示成 <CR>，方便肉眼核对
const shown = slice
  .replace(/\u001B/g, '<ESC>')
  .replace(/\r/g, '<CR>\n')
  .replace(/\n{3,}/g, '\n\n')

console.log('=== 锚点前后原始字节（ESC 已显式标出）===')
console.log(shown)

console.log()
console.log('=== 该区域内 SGR 计数 ===')
const region = raw.slice(from, to)
for (const code of ['1', '2', '0', '22', '39']) {
  const n = (region.match(new RegExp(`\\u001B\\[${code}m`, 'g')) || []).length
  console.log(`  ESC[${code}m : ${n}`)
}
console.log()
console.log('=== 全文 SGR 计数（含所有重绘帧）===')
for (const code of ['1', '2', '0']) {
  const n = (raw.match(new RegExp(`\\u001B\\[${code}m`, 'g')) || []).length
  console.log(`  ESC[${code}m : ${n}`)
}
