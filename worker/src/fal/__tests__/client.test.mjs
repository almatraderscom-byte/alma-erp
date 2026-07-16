/**
 * CS5 — Fal durable client contract tests (node:test, zero new dependencies).
 * Run: node --test worker/src/fal/__tests__/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ALLOWED_FAL_ENDPOINTS,
  assertAllowedFalEndpoint,
  falAppBase,
  falSubmit,
  loadFalRequestState,
  runFalQueueJob,
  saveFalRequestState,
} from '../client.mjs'
import { falInputFingerprint, stableStringify } from '../fingerprint.mjs'

process.env.FAL_KEY = 'test-key'

/** Minimal in-memory stand-in for the supabase agent_kv_settings table. */
function fakeSupabase(store = new Map()) {
  return {
    store,
    from(table) {
      assert.equal(table, 'agent_kv_settings')
      return {
        select() {
          return {
            eq(_col, key) {
              return {
                maybeSingle: async () => ({
                  data: store.has(key) ? { value: store.get(key) } : null,
                }),
              }
            },
          }
        },
        upsert: async (row) => {
          store.set(row.key, row.value)
          return { error: null }
        },
        delete() {
          return { eq: async (_col, key) => { store.delete(key); return { error: null } } }
        },
      }
    },
  }
}

/** Scripted fetch mock: routes on URL substring + method. */
function scriptedFetch(script) {
  const calls = []
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET' })
    for (const rule of script) {
      if (String(url).includes(rule.match) && (!rule.method || rule.method === (init.method ?? 'GET'))) {
        const hit = rule.responses ? rule.responses.shift() ?? rule.responses.last : rule.response
        if (rule.responses && !hit) throw new Error(`script exhausted for ${rule.match}`)
        return {
          ok: hit.status < 400,
          status: hit.status,
          json: async () => hit.body,
        }
      }
    }
    throw new Error(`unscripted fetch: ${init.method ?? 'GET'} ${url}`)
  }
  impl.calls = calls
  return impl
}

const noSleep = async () => {}

test('fingerprint: stable across key order, distinct across inputs', () => {
  const a = falInputFingerprint('fal-ai/cat-vton', { x: 1, y: { b: 2, a: [1, 2] } })
  const b = falInputFingerprint('fal-ai/cat-vton', { y: { a: [1, 2], b: 2 }, x: 1 })
  const c = falInputFingerprint('fal-ai/cat-vton', { x: 2, y: { a: [1, 2], b: 2 } })
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.equal(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}')
})

test('allowlist: exactly the three roadmap endpoints; injection rejected', async () => {
  assert.deepEqual(
    [...ALLOWED_FAL_ENDPOINTS].sort(),
    ['fal-ai/cat-vton', 'fal-ai/fashn/tryon/v1.6', 'fal-ai/flux-pro/v1/fill'],
  )
  assert.doesNotThrow(() => assertAllowedFalEndpoint('fal-ai/cat-vton'))
  assert.throws(() => assertAllowedFalEndpoint('fal-ai/evil-model'), /not allowlisted/)
  // the submit path must gate too — and must not reach the network
  await assert.rejects(
    () => falSubmit('fal-ai/evil-model', {}, { fetchImpl: async () => { throw new Error('must not fetch') } }),
    /not allowlisted/,
  )
})

test('falAppBase: nested endpoint paths poll under the two-segment app id', () => {
  assert.equal(falAppBase('fal-ai/flux-pro/v1/fill'), 'fal-ai/flux-pro')
  assert.equal(falAppBase('fal-ai/fashn/tryon/v1.6'), 'fal-ai/fashn')
  assert.equal(falAppBase('fal-ai/cat-vton'), 'fal-ai/cat-vton')
})

test('submit → request id persisted BEFORE polling; result returned', async () => {
  const supabase = fakeSupabase()
  const fetchImpl = scriptedFetch([
    { match: '/requests/req-1/status', response: { status: 200, body: { status: 'COMPLETED' } } },
    { match: '/requests/req-1', response: { status: 200, body: { images: [{ url: 'https://cdn/img.png' }] } } },
    { match: 'queue.fal.run/fal-ai/cat-vton', method: 'POST', response: { status: 200, body: { request_id: 'req-1' } } },
  ])
  const fp = falInputFingerprint('fal-ai/cat-vton', { human_image_url: 'a', garment_image_url: 'b' })
  const out = await runFalQueueJob({
    supabase,
    pendingActionId: 'pa-1',
    endpointId: 'fal-ai/cat-vton',
    input: { human_image_url: 'a', garment_image_url: 'b' },
    inputFingerprint: fp,
    intervalMs: 0,
    sleep: noSleep,
    fetchImpl,
  })
  assert.equal(out.requestId, 'req-1')
  assert.equal(out.resumed, false)
  assert.ok(out.payload.images[0].url)
  // state row survives success — caller clears it only after storage upload
  const state = await loadFalRequestState(supabase, 'pa-1')
  assert.equal(state.requestId, 'req-1')
  assert.equal(state.inputFingerprint, fp)
  assert.equal(state.attempt, 1)
})

test('restart resume: same fingerprint NEVER submits a second paid request', async () => {
  const supabase = fakeSupabase()
  await saveFalRequestState(supabase, 'pa-2', {
    endpointId: 'fal-ai/fashn/tryon/v1.6',
    requestId: 'req-old',
    submittedAt: '2026-07-16T00:00:00Z',
    inputFingerprint: falInputFingerprint('fal-ai/fashn/tryon/v1.6', { g: 1 }),
    attempt: 1,
  })
  const fetchImpl = scriptedFetch([
    { match: '/requests/req-old/status', response: { status: 200, body: { status: 'COMPLETED' } } },
    { match: '/requests/req-old', response: { status: 200, body: { done: true } } },
    // NO submit rule: a POST to the queue root would throw "unscripted fetch"
  ])
  const out = await runFalQueueJob({
    supabase,
    pendingActionId: 'pa-2',
    endpointId: 'fal-ai/fashn/tryon/v1.6',
    input: { g: 1 },
    inputFingerprint: falInputFingerprint('fal-ai/fashn/tryon/v1.6', { g: 1 }),
    intervalMs: 0,
    sleep: noSleep,
    fetchImpl,
  })
  assert.equal(out.resumed, true)
  assert.equal(out.requestId, 'req-old')
  assert.ok(!fetchImpl.calls.some((c) => c.method === 'POST'), 'no paid resubmit happened')
})

test('changed input (fingerprint mismatch) drops stale state and submits fresh', async () => {
  const supabase = fakeSupabase()
  await saveFalRequestState(supabase, 'pa-3', {
    endpointId: 'fal-ai/cat-vton',
    requestId: 'req-stale',
    submittedAt: '2026-07-16T00:00:00Z',
    inputFingerprint: 'old-fp',
    attempt: 1,
  })
  const fetchImpl = scriptedFetch([
    { match: '/requests/req-new/status', response: { status: 200, body: { status: 'COMPLETED' } } },
    { match: '/requests/req-new', response: { status: 200, body: { ok: 1 } } },
    { match: 'queue.fal.run/fal-ai/cat-vton', method: 'POST', response: { status: 200, body: { request_id: 'req-new' } } },
  ])
  const out = await runFalQueueJob({
    supabase,
    pendingActionId: 'pa-3',
    endpointId: 'fal-ai/cat-vton',
    input: { different: true },
    inputFingerprint: falInputFingerprint('fal-ai/cat-vton', { different: true }),
    intervalMs: 0,
    sleep: noSleep,
    fetchImpl,
  })
  assert.equal(out.requestId, 'req-new')
})

test('result download failure keeps state (resume retrieval, no re-pay)', async () => {
  const supabase = fakeSupabase()
  const fetchImpl = scriptedFetch([
    { match: '/requests/req-4/status', response: { status: 200, body: { status: 'COMPLETED' } } },
    { match: '/requests/req-4', response: { status: 500, body: {} } },
    { match: 'queue.fal.run/fal-ai/cat-vton', method: 'POST', response: { status: 200, body: { request_id: 'req-4' } } },
  ])
  await assert.rejects(
    () => runFalQueueJob({
      supabase,
      pendingActionId: 'pa-4',
      endpointId: 'fal-ai/cat-vton',
      input: { a: 1 },
      inputFingerprint: falInputFingerprint('fal-ai/cat-vton', { a: 1 }),
      intervalMs: 0,
      sleep: noSleep,
      fetchImpl,
    }),
    /fal result 500/,
  )
  const state = await loadFalRequestState(supabase, 'pa-4')
  assert.equal(state.requestId, 'req-4', 'state survives — next run resumes the same paid request')
})

test('transient poll errors retry bounded, then succeed', async () => {
  const supabase = fakeSupabase()
  const fetchImpl = scriptedFetch([
    {
      match: '/requests/req-5/status',
      responses: [
        { status: 429, body: {} },
        { status: 500, body: {} },
        { status: 200, body: { status: 'IN_PROGRESS' } },
        { status: 200, body: { status: 'COMPLETED' } },
      ],
    },
    { match: '/requests/req-5', response: { status: 200, body: { ok: 1 } } },
    { match: 'queue.fal.run/fal-ai/cat-vton', method: 'POST', response: { status: 200, body: { request_id: 'req-5' } } },
  ])
  const out = await runFalQueueJob({
    supabase,
    pendingActionId: 'pa-5',
    endpointId: 'fal-ai/cat-vton',
    input: { a: 1 },
    inputFingerprint: falInputFingerprint('fal-ai/cat-vton', { a: 1 }),
    intervalMs: 0,
    sleep: noSleep,
    fetchImpl,
  })
  assert.equal(out.requestId, 'req-5')
})

test('fal-side FAILED clears state so a future run may legitimately resubmit', async () => {
  const supabase = fakeSupabase()
  const fetchImpl = scriptedFetch([
    { match: '/requests/req-6/status', response: { status: 200, body: { status: 'FAILED' } } },
    { match: 'queue.fal.run/fal-ai/cat-vton', method: 'POST', response: { status: 200, body: { request_id: 'req-6' } } },
  ])
  await assert.rejects(
    () => runFalQueueJob({
      supabase,
      pendingActionId: 'pa-6',
      endpointId: 'fal-ai/cat-vton',
      input: { a: 1 },
      inputFingerprint: falInputFingerprint('fal-ai/cat-vton', { a: 1 }),
      intervalMs: 0,
      sleep: noSleep,
      fetchImpl,
    }),
    /fal job failed/,
  )
  assert.equal(await loadFalRequestState(supabase, 'pa-6'), null)
})
