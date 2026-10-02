import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
	advanceRepeatChain,
	canonicalizeArguments,
	decideLoopVerdict,
	previewArguments,
	renderLoopNotice,
	renderRecoveryPrompt,
	sortJsonValue,
} from '../lib/types/loop-detect.js'

const policy = (over = {}) => ({ enabled: true, repeatThreshold: 4, compact: true, maxInterventions: 2, ...over })
const chain = (count, name = 'bash', canonical = '{"a":1}') => ({ key: JSON.stringify([name, canonical]), count })

test('sortJsonValue sorts keys deeply and preserves array order', () => {
	assert.deepEqual(sortJsonValue({ b: 1, a: 2 }), { a: 2, b: 1 })
	assert.deepEqual(sortJsonValue({ z: { y: 1, x: 2 }, a: [{ d: 1, c: 2 }] }), { a: [{ c: 2, d: 1 }], z: { x: 2, y: 1 } })
	// Array order is meaningful, so it must survive canonicalization.
	assert.deepEqual(sortJsonValue([3, 1, 2]), [3, 1, 2])
	assert.equal(sortJsonValue(null), null)
	assert.equal(sortJsonValue('text'), 'text')
	assert.equal(sortJsonValue(7), 7)
})

test('canonicalizeArguments makes property order irrelevant but value order significant', () => {
	assert.equal(canonicalizeArguments({ command: 'ls', timeout: 5 }), canonicalizeArguments({ timeout: 5, command: 'ls' }))
	assert.equal(canonicalizeArguments({ nested: { b: 1, a: 2 } }), canonicalizeArguments({ nested: { a: 2, b: 1 } }))
	assert.notEqual(canonicalizeArguments({ list: [1, 2] }), canonicalizeArguments({ list: [2, 1] }))
	assert.notEqual(canonicalizeArguments({ n: 1 }), canonicalizeArguments({ n: '1' }))
	// A missing value still yields one stable token, so a chain key is well-formed.
	assert.equal(canonicalizeArguments(undefined), 'null')
})

test('advanceRepeatChain counts one run and resets on any difference', () => {
	const first = advanceRepeatChain(undefined, 'bash', '{"a":1}')
	assert.deepEqual(first, { key: JSON.stringify(['bash', '{"a":1}']), count: 1 })
	assert.equal(advanceRepeatChain(first, 'bash', '{"a":1}').count, 2)
	assert.equal(advanceRepeatChain(advanceRepeatChain(first, 'bash', '{"a":1}'), 'bash', '{"a":1}').count, 3)
	// A different tool, or different arguments for the same tool, starts over.
	assert.equal(advanceRepeatChain(first, 'read', '{"a":1}').count, 1)
	assert.equal(advanceRepeatChain(first, 'bash', '{"a":2}').count, 1)
})

test('decideLoopVerdict interrupts only at the threshold', () => {
	assert.equal(decideLoopVerdict(chain(3), policy(), false, 0).kind, 'continue')
	const verdict = decideLoopVerdict(chain(4), policy(), false, 0)
	assert.deepEqual(verdict, { kind: 'intervene', count: 4, name: 'bash' })
	assert.equal(decideLoopVerdict(chain(9), policy(), false, 0).kind, 'intervene')
})

test('decideLoopVerdict never interrupts while an autonomous driver owns continuation', () => {
	// Both DSH's goal driver and this plugin's loop driver pause their mechanism
	// when an admitted round is cancelled, so interrupting here would silently
	// end the user's goal or loop.
	const verdict = decideLoopVerdict(chain(6), policy(), true, 0)
	assert.deepEqual(verdict, { kind: 'nudge', count: 6, name: 'bash' })
})

test('decideLoopVerdict stops interrupting once the intervention budget is spent', () => {
	assert.equal(decideLoopVerdict(chain(4), policy(), false, 1).kind, 'intervene')
	const spent = decideLoopVerdict(chain(4), policy(), false, 2)
	assert.equal(spent.kind, 'nudge')
	assert.deepEqual(decideLoopVerdict(chain(4), policy({ maxInterventions: 1 }), false, 1), { kind: 'nudge', count: 4, name: 'bash' })
})

test('decideLoopVerdict honours the enable switch and a custom threshold', () => {
	assert.equal(decideLoopVerdict(chain(50), policy({ enabled: false }), false, 0).kind, 'continue')
	assert.equal(decideLoopVerdict(chain(2), policy({ repeatThreshold: 2 }), false, 0).kind, 'intervene')
	assert.equal(decideLoopVerdict(chain(1), policy({ repeatThreshold: 2 }), false, 0).kind, 'continue')
})

test('previewArguments truncates long arguments and labels the remainder', () => {
	assert.equal(previewArguments('short', 10), 'short')
	const long = previewArguments('x'.repeat(20), 5)
	assert.match(long, /^xxxxx… \(\+15 more chars\)$/)
})

test('renderLoopNotice names the tool, the run length, and the next action', () => {
	const [block] = renderLoopNotice('bash', 4, '{"command":"ls"}')
	assert.equal(block.type, 'text')
	assert.match(block.text, /Repeated tool call detected/)
	assert.match(block.text, /tool: bash/)
	assert.match(block.text, /consecutive_calls: 4/)
	assert.match(block.text, /"command":"ls"/)
	assert.match(block.text, /Do not call this tool with these exact arguments again/)
})

test('renderRecoveryPrompt distinguishes a compacted recovery from a plain one', () => {
	const compacted = renderRecoveryPrompt('bash', 4, true)[0].text
	assert.match(compacted, /<loop_interrupted>/)
	assert.match(compacted, /history has just been compacted/)
	assert.match(compacted, /- tool: bash/)
	assert.match(compacted, /- consecutive_calls: 4/)
	assert.match(compacted, /Continue the task from the compacted state/)
	const plain = renderRecoveryPrompt('read', 3, false)[0].text
	assert.doesNotMatch(plain, /compacted/)
	assert.match(plain, /interrupted because you repeated one tool call/)
	assert.match(plain, /Continue the task\. The repeated call/)
})
