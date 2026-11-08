/** Focused probe: which JSON keys make canonicalizeArguments non-idempotent? */
import { canonicalizeArguments } from './lib/types/loop-detect.js'

const cases = {
	proto: JSON.parse('{"__proto__":{"a":1},"b":2}'),
	constructor: JSON.parse('{"constructor":1,"b":2}'),
	quote: JSON.parse('{"\\"":1,"b":2}'),
	backslash: JSON.parse('{"\\\\":1,"b":2}'),
	lone: JSON.parse('{"\\ud800":1,"b":2}'),
	empty: JSON.parse('{"":1,"b":2}'),
	numeric: JSON.parse('{"10":1,"9":2,"b":3}'),
	proto_dup: JSON.parse('{"__proto__":{"a":1},"__proto__2":2}'),
	nested_proto: { a: JSON.parse('{"__proto__":{"x":1}}') },
}

for (const [name, value] of Object.entries(cases)) {
	const first = canonicalizeArguments(value)
	const second = canonicalizeArguments(JSON.parse(first))
	const ownKeys = first === second ? '' : ` ownKeysBefore=${JSON.stringify(Object.keys(value))}`
	console.log(`${name}: ${first === second ? 'idempotent' : 'NOT idempotent'}${ownKeys}\n  first=${first}\n  second=${second}`)
}
const polluted = ({}).a
console.log('Object.prototype.a after proto case =', polluted)
