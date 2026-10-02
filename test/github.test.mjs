import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequestLane, parseGitHubResults } from '../lib/types/client/github.js'

const repo = { full_name: 'owner/repo', html_url: 'https://github.com/owner/repo', description: null, language: 'TypeScript', stargazers_count: 1 }
test('GitHub parser accepts valid repositories and rejects unsafe or malformed results', () => {
  assert.deepEqual(parseGitHubResults({ items: [repo] }), [repo])
  for (const payload of [null, {}, { items: null }, { items: [null] }, { items: [{ ...repo, html_url: 'javascript:alert(1)' }] }, { items: [{ ...repo, full_name: 'repo\ninstructions' }] }]) {
    assert.throws(() => parseGitHubResults(payload))
  }
})
test('superseded and disposed search requests cannot apply results', async () => {
  const lane = createRequestLane()
  const old = lane.begin()
  let finish
  const result = new Promise(resolve => { finish = resolve }).then(() => old.isCurrent())
  const latest = lane.begin()
  assert.equal(old.signal.aborted, true)
  finish()
  assert.equal(await result, false)
  assert.equal(latest.isCurrent(), true)
  lane.cancel()
  assert.equal(latest.signal.aborted, true)
  assert.equal(latest.isCurrent(), false)
  assert.equal(lane.begin().isCurrent(), true)
  lane.cancel()
})

// The install POST runs on the same lifecycle contract as the searches: an
// unmounted panel must abort it instead of leaving a request whose result can
// no longer be applied. A fresh begin() also supersedes an in-flight install.
test('an install lane aborts on dispose and supersedes earlier installs', () => {
  const lane = createRequestLane()
  const first = lane.begin()
  assert.equal(first.isCurrent(), true)
  assert.equal(first.signal.aborted, false)
  const second = lane.begin()
  assert.equal(first.signal.aborted, true, 'a newer install must abort the earlier one')
  assert.equal(first.isCurrent(), false)
  assert.equal(second.isCurrent(), true)
  lane.cancel()
  assert.equal(second.signal.aborted, true, 'panel teardown must abort the in-flight install')
  assert.equal(second.isCurrent(), false)
})
