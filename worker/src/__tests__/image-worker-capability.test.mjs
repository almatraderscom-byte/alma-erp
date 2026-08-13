import assert from 'node:assert/strict'
import test from 'node:test'
import {
  IMAGE_WORKER_CAPABILITY_KV_KEY,
  IMAGE_WORKER_CAPABILITY_PUBLISH_INTERVAL_MS,
  IMAGE_WORKER_CAPABILITY_SOURCE,
  IMAGE_WORKER_CAPABILITY_VERSION,
  genericImageModelsFromWorkerEnv,
  publishImageWorkerCapabilityReceipt,
  startImageWorkerCapabilityPublisher,
} from '../image/capability-receipt.mjs'

function fakeSupabase(error = null) {
  const writes = []
  return {
    writes,
    client: {
      from(table) {
        return {
          async upsert(value, options) {
            writes.push({ table, value, options })
            return { error }
          },
        }
      },
    },
  }
}

test('derives the exact generic model list from the credentials used by worker adapters', () => {
  assert.deepEqual(genericImageModelsFromWorkerEnv({
    GEMINI_API_KEY: ' gemini ',
    OPENAI_API_KEY: 'openai',
    FAL_KEY: '   ',
  }), [
    'gemini-3.1-flash-image',
    'gemini-3-pro-image',
    'gpt-image-2',
  ])
  assert.deepEqual(genericImageModelsFromWorkerEnv({ FAL_KEY: 'fal' }), [
    'seedream-5.0-pro',
  ])
})

test('publishes a versioned, stamped receipt with no credential material', async () => {
  const supabase = fakeSupabase()
  const receipt = await publishImageWorkerCapabilityReceipt({
    supabase: supabase.client,
    env: { GEMINI_API_KEY: 'private-gemini', FAL_KEY: 'private-fal' },
    now: new Date('2026-08-11T06:00:00.000Z'),
  })

  assert.deepEqual(receipt, {
    version: IMAGE_WORKER_CAPABILITY_VERSION,
    source: IMAGE_WORKER_CAPABILITY_SOURCE,
    updatedAt: '2026-08-11T06:00:00.000Z',
    models: [
      'gemini-3.1-flash-image',
      'gemini-3-pro-image',
      'seedream-5.0-pro',
    ],
  })
  // Build 103: one atomic upsert per protocol version — v1 stays untouched
  // for un-upgraded servers, v2 adds the proven preset/tier matrix.
  assert.equal(supabase.writes.length, 2)
  assert.deepEqual(supabase.writes[0], {
    table: 'agent_kv_settings',
    value: {
      key: IMAGE_WORKER_CAPABILITY_KV_KEY,
      value: JSON.stringify(receipt),
      updated_at: receipt.updatedAt,
    },
    options: { onConflict: 'key' },
  })
  const v2Write = supabase.writes[1]
  assert.equal(v2Write.value.key, 'image_worker_capabilities_v2')
  const v2 = JSON.parse(v2Write.value.value)
  assert.equal(v2.version, 2)
  assert.equal(v2.configContractVersion, 1)
  assert.deepEqual(v2.models, receipt.models)
  assert.ok(v2.presets['gemini-3-pro-image'].poster.includes('2K'))
  // Seedream poster proves only up to 2K; GPT is absent (no OPENAI key here).
  assert.deepEqual(v2.presets['seedream-5.0-pro'].poster, ['1K', '2K'])
  assert.equal(v2.presets['gpt-image-2'], undefined)
  for (const write of supabase.writes) {
    assert.doesNotMatch(write.value.value, /private-/)
  }
})

test('publishes immediately, refreshes periodically, and stops its timer', async () => {
  const supabase = fakeSupabase()
  let scheduled = null
  let cleared = null
  let tick = 0
  const publisher = startImageWorkerCapabilityPublisher({
    supabase: supabase.client,
    env: { GEMINI_API_KEY: 'gemini' },
    now: () => new Date(`2026-08-11T06:0${tick++}:00.000Z`),
    schedule(callback, intervalMs) {
      scheduled = { callback, intervalMs, token: Symbol('timer') }
      return scheduled.token
    },
    unschedule(token) {
      cleared = token
    },
  })
  await publisher.ready

  // Two writes per publish tick: the v1 receipt and the v2 receipt.
  assert.equal(supabase.writes.length, 2)
  assert.equal(scheduled.intervalMs, IMAGE_WORKER_CAPABILITY_PUBLISH_INTERVAL_MS)
  await scheduled.callback()
  assert.equal(supabase.writes.length, 4)
  assert.notEqual(supabase.writes[0].value.value, supabase.writes[2].value.value)

  publisher.stop()
  assert.equal(cleared, scheduled.token)
  await publisher.refresh()
  assert.equal(supabase.writes.length, 4)
})

test('surfaces a failed atomic KV upsert to the publisher error hook', async () => {
  const failure = new Error('kv unavailable')
  const supabase = fakeSupabase(failure)
  const errors = []
  const publisher = startImageWorkerCapabilityPublisher({
    supabase: supabase.client,
    env: { GEMINI_API_KEY: 'gemini' },
    schedule: () => Symbol('timer'),
    unschedule: () => {},
    onError: (error) => errors.push(error),
  })
  await publisher.ready
  publisher.stop()
  assert.deepEqual(errors, [failure])
})
