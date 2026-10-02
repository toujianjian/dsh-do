import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installAiInstallRoute } from '../lib/types/ai-install.js'

function route(overrides = {}) {
  let handler
  let created = 0
  const services = {
    webServer: { register(spec) { handler = spec.handler; return () => {} } },
    agents: { list: () => [], create() { created++; throw Error('unexpected creation') } },
    ...overrides,
  }
  const child = { get: name => services[name], agents: services.agents, effect: fn => fn() }
  installAiInstallRoute({ inject: (_deps, fn) => fn(child) })
  return async (headers, method = 'POST', body = '{"prompt":"install something"}') => {
    const req = Readable.from([Buffer.from(body)])
    req.method = method
    req.headers = { host: '127.0.0.1:3080', ...headers }
    let response
    const res = { setHeader() {}, end(text) { response = JSON.parse(text) } }
    await handler(req, res)
    assert.equal(created, 0)
    return { status: res.statusCode, body: response }
  }
}

test('successful installation mounts preset and queues one plugin notice', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-do-install-test-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  let mounted = 0
  let queued
  let deleted = false
  try {
    const request = route({
      agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
      agentPresets: { defaultId: 'test', async mount(_ctx, id) { assert.equal(id, 'test'); mounted++ } },
      workspaceRegistry: { create: async () => ({ id: 'owned' }), delete: async () => { deleted = true } },
      agents: { list: () => [], async create(options) {
        assert.equal(options.agentOptions.model, 'test')
        assert.equal(options.meta.agentPreset, 'test')
        await options.setup({})
        return { agent: { followup(message) { queued = message } }, async dispose() { throw Error('must retain successful session') } }
      } },
    })
    const response = await request({ 'content-type': 'application/json' })
    assert.equal(response.status, 200)
    assert.match(response.body.sessionId, /^dsh-do-install-/)
    assert.equal(mounted, 1)
    assert.equal(queued.source.kind, 'plugin')
    assert.equal(deleted, false)
    assert.equal((await readdir(join(home, 'dsh-do-installs'))).length, 1)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('failed agent setup rolls back only its newly allocated empty workspace', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-do-install-test-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  let deleted
  try {
    const request = route({
      agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
      agentPresets: { defaultId: 'test', mount() {} },
      workspaceRegistry: { create: async () => ({ id: 'owned' }), delete: async id => { deleted = id } },
      agents: { list: () => [], create: async () => { throw Error('setup failed') } },
    })
    assert.equal((await request({ 'content-type': 'application/json' })).status, 500)
    assert.equal(deleted, 'owned')
    assert.deepEqual(await readdir(join(home, 'dsh-do-installs')), [])
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('missing preset or workspace registry fails before allocating a workspace', async () => {
  const request = route({ agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) } })
  assert.equal((await request({ origin: 'http://127.0.0.1:3080', 'content-type': 'application/json' })).status, 503)
})

test('install route rejects cross-site requests before creating resources', async () => {
  const request = route()
  assert.equal((await request({ origin: 'https://evil.example', 'content-type': 'application/json' })).status, 403)
  assert.equal((await request({ 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' })).status, 403)
})

test('install route rejects form and missing content types', async () => {
  const request = route()
  assert.equal((await request({ 'content-type': 'text/plain' })).status, 415)
  assert.equal((await request({})).status, 415)
})

test('install route validates method and JSON before resource creation', async () => {
  const request = route()
  assert.equal((await request({}, 'GET')).status, 405)
  assert.equal((await request({ 'content-type': 'application/json' }, 'POST', '{bad')).status, 400)
  assert.equal((await request({ 'content-type': 'application/json' }, 'POST', '{}')).status, 400)
})
