/** How deep can a provider's JSON arguments actually be? (JSON.parse limit) */
for (const depth of [1000, 2000, 3000, 4000, 5000, 8000, 12000]) {
	const text = '['.repeat(depth) + ']'.repeat(depth)
	try {
		JSON.parse(text)
		console.log(`JSON.parse depth ${depth}: ok`)
	} catch (error) {
		console.log(`JSON.parse depth ${depth}: ${error.name}`)
	}
}
