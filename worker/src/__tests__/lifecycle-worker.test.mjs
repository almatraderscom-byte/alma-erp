import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  executeLifecycleClaim,
  renderCompositionManifest,
  runLifecycleWorkerTick,
} from '../lifecycle-worker.mjs'

function claim(overrides = {}) {
  return {
    id: 'job-1',
    status: 'running',
    leaseToken: 'lease-1',
    effectClass: 'zero_cost_local',
    paidExecutionAllowed: false,
    kind: 'export',
    renderProfile: 'composition-manifest-v1',
    outputFormat: 'json',
    rendererVersion: 'composition-manifest-v1',
    compositionId: 'composition-1',
    compositionVersionId: 'composition-version-2',
    compositionVersion: 2,
    compositionDocumentHash: 'a'.repeat(64),
    operationBatchId: 'batch-2',
    sourceArtifactVersionId: 'asset-version-2',
    approvedReviewEventId: 'review-2',
    approvedArtifactVersionId: 'asset-version-2',
    reviewFingerprint: 'b'.repeat(64),
    renderFingerprint: 'c'.repeat(64),
    compositionDocument: { schemaVersion: 1, compositionId: 'composition-1' },
    ...overrides,
  }
}

function storageHarness({ uploadError = null } = {}) {
  let uploaded = null
  return {
    get uploaded() { return uploaded },
    client: {
      storage: {
        from() {
          return {
            async upload(_path, bytes) {
              uploaded = Buffer.from(bytes)
              return { error: uploadError }
            },
            async download() {
              return {
                data: uploaded
                  ? { arrayBuffer: async () => uploaded }
                  : null,
                error: uploaded ? null : new Error('missing'),
              }
            },
          }
        },
      },
    },
  }
}

test('lifecycle worker remains inert while its independent gate is off', async () => {
  let calls = 0
  const result = await runLifecycleWorkerTick({
    appUrl: 'https://app.example',
    internalToken: 'token',
    supabase: {},
    enabled: false,
    fetchImpl: async () => {
      calls += 1
      throw new Error('must not execute')
    },
  })
  assert.deepEqual(result, {
    status: 'skipped',
    reason: 'lifecycle_worker_disabled',
    processed: 0,
  })
  assert.equal(calls, 0)
})

test('manifest renderer is deterministic and hard-rejects paid/provider claims', () => {
  const first = renderCompositionManifest(claim())
  const second = renderCompositionManifest(claim())
  assert.equal(first.checksum, second.checksum)
  assert.deepEqual(first.bytes, second.bytes)
  assert.throws(
    () => renderCompositionManifest(claim({
      effectClass: 'paid',
      paidExecutionAllowed: true,
    })),
    /paid_or_external_lifecycle_claim_rejected/,
  )
  assert.throws(
    () => renderCompositionManifest(claim({ renderProfile: 'provider-video-v1' })),
    /local_lifecycle_renderer_not_registered/,
  )
})

test('worker fetches back exact bytes before reporting a ready receipt', async () => {
  const storage = storageHarness()
  const callbacks = []
  const result = await executeLifecycleClaim({
    job: claim(),
    appUrl: 'https://app.example',
    internalToken: 'token',
    supabase: storage.client,
    fetchImpl: async (_url, init) => {
      callbacks.push(JSON.parse(init.body))
      return new Response(JSON.stringify({
        job: { id: 'job-1', status: 'ready' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })
  assert.equal(result.status, 'ready')
  assert.equal(callbacks.length, 1)
  assert.equal(callbacks[0].outcome, 'ready')
  assert.equal(callbacks[0].checksum.length, 64)
  assert.equal(callbacks[0].sizeBytes, storage.uploaded.length)
})

test('an upload-side ambiguity is quarantined and never auto-retried', async () => {
  const storage = storageHarness({ uploadError: new Error('timeout') })
  const callbacks = []
  const result = await executeLifecycleClaim({
    job: claim(),
    appUrl: 'https://app.example',
    internalToken: 'token',
    supabase: storage.client,
    fetchImpl: async (_url, init) => {
      callbacks.push(JSON.parse(init.body))
      return new Response(JSON.stringify({ job: { status: 'needs_review' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })
  assert.deepEqual(result, {
    status: 'needs_review',
    error: 'lifecycle_upload_failed:timeout',
    retryAllowed: false,
  })
  assert.equal(callbacks.length, 1)
  assert.equal(callbacks[0].outcome, 'failed')
  assert.equal(callbacks[0].ambiguousEffect, true)
})
