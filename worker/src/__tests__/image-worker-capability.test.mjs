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
  assert.deepEqual(supabase.writes, [{
    table: 'agent_kv_settings',
    value: {
      key: IMAGE_WORKER_CAPABILITY_KV_KEY,
      value: JSON.stringify(receipt),
      updated_at: receipt.updatedAt,
    },
    options: { onConflict: 'key' },
  }])
  assert.doesNotMatch(supabase.writes[0].value.value, /private-/)
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

  assert.equal(supabase.writes.length, 1)
  assert.equal(scheduled.intervalMs, IMAGE_WORKER_CAPABILITY_PUBLISH_INTERVAL_MS)
  await scheduled.callback()
  assert.equal(supabase.writes.length, 2)
  assert.notEqual(supabase.writes[0].value.value, supabase.writes[1].value.value)

  publisher.stop()
  assert.equal(cleared, scheduled.token)
  await publisher.refresh()
  assert.equal(supabase.writes.length, 2)
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
