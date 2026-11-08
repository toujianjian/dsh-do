/**
 * Shared generators for the brute-force harness.
 *
 * The point of this corpus is not "random garbage" (JSON.parse already rejects
 * that) but values that are structurally plausible yet hostile to the code
 * under test: wrong types in the right places, boundary numbers, lone
 * surrogates, NUL bytes, prototype-ish keys, very deep nesting, and very large
 * payloads.
 */

/** Deterministic PRNG so a crash is always reproducible. */
export function rng(seed = 0x5eed) {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

const WEIRD_STRINGS = [
	'',
	' ',
	'\u0000',
	'a\u0000b',
	'\u001b[1m\u001b[0m',
	'😀'.repeat(8),
	'\ud800', // lone high surrogate
	'\udfff', // lone low surrogate
	'a\ud800b\udc00c',
	'中文测试',
	'e\u0301', // combining mark
	'\r\n\t',
	'__proto__',
	'constructor',
	'prototype',
	'../../etc/passwd',
	'loop-x',
	'0',
	'-1',
	'1e309',
	'NaN',
	'Infinity',
	'null',
	'"',
	'\\',
	'x'.repeat(10_000),
]

const NUMBERS = [
	0, -0, 1, -1, 2, 63, 1024, 60_000, 2_147_483_647, 2_147_483_648, 9_007_199_254_740_991,
	9_007_199_254_740_992, NaN, Infinity, -Infinity, 0.5, -1.5, 1e-9, 1e21, Number.MAX_VALUE,
]

function pick(list, r) {
	return list[Math.floor(r() * list.length) % list.length]
}

/** A JSON-ish value with hostile leaves, depth ≤ maxDepth. */
export function randomValue(r, depth = 0, maxDepth = 5) {
	const roll = r()
	if (depth >= maxDepth || roll < 0.42) {
		const leaf = r()
		if (leaf < 0.4) return pick(WEIRD_STRINGS, r)
		if (leaf < 0.65) return pick(NUMBERS, r)
		if (leaf < 0.75) return true
		if (leaf < 0.85) return false
		if (leaf < 0.95) return null
		return undefined
	}
	if (roll < 0.72) {
		const n = Math.floor(r() * 5)
		const out = []
		for (let i = 0; i < n; i++) out.push(randomValue(r, depth + 1, maxDepth))
		return out
	}
	const n = Math.floor(r() * 6)
	const out = {}
	for (let i = 0; i < n; i++) {
		const key = r() < 0.15 ? pick(['__proto__', 'constructor', 'prototype', 'toString'], r) : r() < 0.3 ? pick(WEIRD_STRINGS, r).slice(0, 20) : `k${Math.floor(r() * 100)}`
		Object.defineProperty(out, key, { value: randomValue(r, depth + 1, maxDepth), enumerable: true, writable: true, configurable: true })
	}
	return out
}

/** Walk a JSON tree and replace one node/leaf, plus occasionally a key. */
export function mutateJson(root, r) {
	const clones = JSON.parse(JSON.stringify(root))
	const nodes = []
	const walk = (node) => {
		if (node === null || typeof node !== 'object') return
		if (Array.isArray(node)) node.forEach(walk)
		else for (const key of Object.keys(node)) walk(node[key])
		nodes.push(node)
	}
	walk(clones)
	if (nodes.length === 0) return randomValue(r)
	const host = pick(nodes, r)
	const keyList = Array.isArray(host) ? host.map((_, i) => i) : Object.keys(host)
	if (keyList.length === 0) return clones
	const key = pick(keyList, r)
	const action = r()
	if (action < 0.35) host[key] = randomValue(r, 2)
	else if (action < 0.6) delete host[key]
	else if (action < 0.8) {
		const replacement = {}
		replacement[`${key}_dup`] = host[key]
		host[`${key}_dup`] = host[key]
	} else host[key] = Array.isArray(host[key]) ? {} : [host[key]]
	return clones
}

/** A deeply nested plain object/array chain (built iteratively; JSON can't express it). */
export function deepChain(depth, leaf = 1, useArrays = false) {
	const root = {}
	let node = root
	for (let i = 0; i < depth; i++) {
		const next = useArrays ? [] : {}
		node.next = next
		node = next
	}
	node.leaf = leaf
	return root
}

/** Random string from a grammar-ish alphabet that stresses the /loop parser. */
export function randomCommandText(r) {
	const parts = [
		'', ' ', 'pause', 'resume', 'edit', 'done', 'cancel', 'clear', 'status', 'every',
		'0s', '1s', '59s', '60s', '1m', '5m', '2h', '1d', '30d', '999999999999999999d',
		'every 5m', 'every 5 minutes', 'every 0m', 'every', 'EVERY 1H', '30秒',
		'\n', '\t', '\u0000', '😀', '中文', '__proto__', '-1m', '+1m', '1e3s', '1.5m',
	]
	const n = Math.floor(r() * 6)
	let text = ''
	for (let i = 0; i < n; i++) text += pick(parts, r)
	return text
}
