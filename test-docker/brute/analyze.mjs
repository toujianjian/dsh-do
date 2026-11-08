/** Summarize a captured BRUTE_* report: counts per area and first N details. */
import { readFileSync } from 'node:fs'

const file = process.argv[2] ?? '/tmp/all.out'
const limit = Number(process.argv[3] ?? 10)
const text = readFileSync(file, 'utf8')
const marker = text.search(/^BRUTE_(PURE|STORE|HTTP|WEB) /m)
if (marker < 0) {
	console.log('no report found')
	process.exit(2)
}
const body = text.slice(marker)
// `run-all.sh` tails each suite, so a report may be followed by the suite's own
// human-readable error lines; take the line the report starts on. `web-load`
// pretty-prints its report, so fall back to parsing from the marker to the end
// of the file.
const reportText = body.slice(body.indexOf(' ') + 1)
let report
try {
	report = JSON.parse(reportText.split('\n')[0])
} catch {
	report = JSON.parse(reportText.trimEnd())
}

const failures = report.failures ?? []
console.log('ok =', report.ok, '| total =', report.total ?? '-', '| failures =', failures.length)
if (Object.keys(report.statuses ?? {}).length > 0) {
	console.log('\nstatus distributions:')
	for (const [label, counts] of Object.entries(report.statuses)) console.log(`- ${label}: ${JSON.stringify(counts)}`)
}
const byArea = new Map()
for (const failure of failures) {
	const area = failure.area ?? 'failure'
	if (!byArea.has(area)) byArea.set(area, [])
	byArea.get(area).push(failure)
}
for (const [area, list] of byArea) {
	console.log(`\n## ${area} (${list.length})`)
	for (const failure of list.slice(0, limit)) console.log(`- ${failure.label}: ${String(failure.detail ?? failure.error).slice(0, 400)}`)
}
const notes = (report.notes ?? []).concat(report.observations ?? [])
const counts = new Map()
for (const note of notes) counts.set(note, (counts.get(note) ?? 0) + 1)
for (const [note, count] of counts) console.log(`note${count > 1 ? ` ×${count}` : ''}: ${note}`)
