import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))

test('single-plugin package has no unpublished local runtime dependencies', () => {
  for (const version of Object.values(pkg.dependencies ?? {})) {
    assert.doesNotMatch(version, /^(link:|file:|workspace:)/)
  }
})

test('all declared package exports exist', async () => {
  for (const entry of Object.values(pkg.exports)) {
    for (const path of typeof entry === 'string' ? [entry] : Object.values(entry)) {
      await access(new URL(path, root))
    }
  }
})

test('bundle declares exactly one stable dsh-do registration', async () => {
  const patch = await readFile(new URL(pkg.dsh.bundle.patch, root), 'utf8')
  assert.equal((patch.match(/\bid:/g) ?? []).length, 1)
  assert.match(patch, /id: do\s+name: dsh-do/)
})
