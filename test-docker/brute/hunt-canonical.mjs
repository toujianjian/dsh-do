/** Hunt a non-idempotent canonicalization and print an exact witness. */
import { rng, randomValue } from './gen.mjs'
import { canonicalizeArguments } from './lib/types/loop-detect.js'

const codes = (text) => [...text].map((ch) => ch.codePointAt(0).toString(16)).join(' ')
const r = rng(1234567)
for (let i = 0; i < 200000; i++) {
	const value = randomValue(r, 0, 6)
	let first
	try {
		first = canonicalizeArguments(value)
	} catch {
		continue
	}
	let second
	try {
		second = canonicalizeArguments(JSON.parse(first))
	} catch {
		continue
	}
	if (first === second) continue
	let at = 0
	while (at < first.length && first[at] === second[at]) at++
	console.log('non-idempotent at', i, 'diff index', at)
	console.log('first  window =', first.slice(Math.max(0, at - 8), at + 8))
	console.log('second window =', second.slice(Math.max(0, at - 8), at + 8))
	console.log('first  codes  =', codes(first.slice(Math.max(0, at - 8), at + 8)))
	console.log('second codes  =', codes(second.slice(Math.max(0, at - 8), at + 8)))
	console.log('reparsed first codes =', codes(JSON.stringify(JSON.parse(first)).slice(Math.max(0, at - 8), at + 8)))
	console.log('plain reparse equal  =', canonicalizeArguments(JSON.parse(first)) === first)
	break
}
