// VPS model-loop V1 — the worker's engine drift guard (Codex P1 #852):
// ordinary deploys advance /opt/alma-erp and restart only the worker, so a
// stale engine must never receive slices; it falls back to Vercel loudly.
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveTurnExecutionUrl, resetEngineCheckCache } from '../turn/run-streamed-turn.mjs'

const APP = 'https://app.example'
const ENGINE = 'http://127.0.0.1:3100'

function buildInfoFetch(commit, { ok = true } = {}) {
  return async (url) => {
    assert.match(String(url), /\/api\/build-info$/)
    return { ok, json: async () => ({ ok: true, commit }) }
  }
}

test.beforeEach(() => {
  process.env.APP_URL = APP
  process.env.WORKER_TURN_ENGINE_URL = ENGINE
  resetEngineCheckCache()
})

test.afterEach(() => {
  delete process.env.WORKER_TURN_ENGINE_URL
})

test('no engine configured → app URL, no probe', async () => {
  delete process.env.WORKER_TURN_ENGINE_URL
  const url = await resolveTurnExecutionUrl({
    fetchImpl: async () => { throw new Error('must not probe') },
    readHead: () => 'abc',
  })
  assert.equal(url, APP)
})

test('matching commit → the engine executes the slice', async () => {
  const url = await resolveTurnExecutionUrl({
    fetchImpl: buildInfoFetch('deadbeef'.repeat(5)),
    readHead: () => 'deadbeef'.repeat(5),
  })
  assert.equal(url, ENGINE)
})

test('drifted engine → fall back to the app', async () => {
  const url = await resolveTurnExecutionUrl({
    fetchImpl: buildInfoFetch('oldsha'),
    readHead: () => 'newsha',
  })
  assert.equal(url, APP)
})

test('unreachable engine or missing commit → fall back to the app', async () => {
  assert.equal(await resolveTurnExecutionUrl({
    fetchImpl: async () => { throw new Error('ECONNREFUSED') },
    readHead: () => 'x',
  }), APP)
  resetEngineCheckCache()
  assert.equal(await resolveTurnExecutionUrl({
    fetchImpl: buildInfoFetch(null),
    readHead: () => 'x',
  }), APP)
  resetEngineCheckCache()
  assert.equal(await resolveTurnExecutionUrl({
    fetchImpl: buildInfoFetch('x', { ok: false }),
    readHead: () => 'x',
  }), APP)
})

test('the verdict is cached inside the TTL and re-probed after it', async () => {
  let probes = 0
  const fetchImpl = async (url) => { probes += 1; return buildInfoFetch('sha1')(url) }
  let clock = 1_000_000
  const now = () => clock
  const deps = { fetchImpl, readHead: () => 'sha1', now }

  assert.equal(await resolveTurnExecutionUrl(deps), ENGINE)
  assert.equal(await resolveTurnExecutionUrl(deps), ENGINE)
  assert.equal(probes, 1)

  clock += 6 * 60 * 1000
  assert.equal(await resolveTurnExecutionUrl(deps), ENGINE)
  assert.equal(probes, 2)
})
