import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDshPluginRegistry, REGISTRY_URL } from '../lib/types/registry.js'

/** A synthetic homepage fragment mimicking the site's embedded RSC entries. */
const SAMPLE_HTML = [
  'noise $R[10]={slug:"demo-a",name:"Demo A",repository:"u/demo-a",repositoryUrl:"https://github.com/u/demo-a",',
  'description:"First demo.",categories:$R[11]=["ui-productivity","dev"],installCommand:"dsh plugin --profile web add demo-a",',
  'status:"manifest-valid",profile:"web",license:"MIT",packageName:"@scope/demo-a",version:"1.0.0",indexedAt:"2026-01-01T00:00:00.000Z"},',
  '$R[12]={slug:"demo-b",name:"Demo B",repository:"u/demo-b",repositoryUrl:"https://github.com/u/demo-b",',
  'description:"Second demo with \\"quotes\\" inside.",categories:$R[13]=["vision"],installCommand:"",',
  'status:"manifest-valid",profile:"unknown",license:void 0,packageName:"demo-b",version:"0.2.0",indexedAt:"2026-01-02T00:00:00.000Z"},',
  '$R[14]={slug:"demo-c",name:"Demo C",repository:"u/demo-c",repositoryUrl:"",description:"Third.",categories:$R[15]=[],',
  'installCommand:"",status:"manifest-invalid",profile:"unknown",license:void 0,packageName:"demo-c",version:"",indexedAt:""},',
  'garbage that must not match',
].join('')

test('parseDshPluginRegistry extracts entries with all field shapes', () => {
  const entries = parseDshPluginRegistry(SAMPLE_HTML)
  assert.equal(entries.length, 3)

  const a = entries[0]
  assert.equal(a.slug, 'demo-a')
  assert.equal(a.name, 'Demo A')
  assert.equal(a.repository, 'u/demo-a')
  assert.equal(a.repositoryUrl, 'https://github.com/u/demo-a')
  assert.equal(a.description, 'First demo.')
  assert.deepEqual(a.categories, ['ui-productivity', 'dev'])
  assert.equal(a.installCommand, 'dsh plugin --profile web add demo-a')
  assert.equal(a.status, 'manifest-valid')
  assert.equal(a.profile, 'web')
  assert.equal(a.license, 'MIT')
  assert.equal(a.packageName, '@scope/demo-a')
  assert.equal(a.version, '1.0.0')
})

test('parseDshPluginRegistry handles JSON escapes and license:void 0', () => {
  const b = parseDshPluginRegistry(SAMPLE_HTML)[1]
  assert.equal(b.description, 'Second demo with "quotes" inside.')
  assert.deepEqual(b.categories, ['vision'])
  assert.equal(b.license, undefined)
})

test('parseDshPluginRegistry skips empty optional fields and malformed text', () => {
  const c = parseDshPluginRegistry(SAMPLE_HTML)[2]
  assert.equal(c.installCommand, undefined)
  assert.equal(c.version, undefined)
  assert.equal(c.indexedAt, undefined)
  assert.deepEqual(c.categories, [])
  // The trailing garbage does not produce an entry.
  assert.equal(parseDshPluginRegistry(SAMPLE_HTML).length, 3)
})

test('parseDshPluginRegistry deduplicates by packageName', () => {
  const html = SAMPLE_HTML + '$R[99]={slug:"demo-a-dup",name:"Demo A",repository:"u/demo-a",repositoryUrl:"",description:"dup",categories:$R[98]=[],installCommand:"",status:"manifest-valid",profile:"unknown",license:void 0,packageName:"@scope/demo-a",version:"2.0.0",indexedAt:""},'
  const entries = parseDshPluginRegistry(html)
  assert.equal(entries.length, 3)
  assert.equal(entries[0].version, '1.0.0')
})

test('REGISTRY_URL points at the registry site', () => {
  assert.equal(REGISTRY_URL, 'https://dshplugin.app/')
})
