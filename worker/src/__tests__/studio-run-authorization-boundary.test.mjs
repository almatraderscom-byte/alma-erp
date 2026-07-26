import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  allowPaidGarmentPrepCleanup,
  assertStudioRunPaidAttempt,
  authorizeStudioRunExecution,
  classifyStudioRunAuthorization,
  studioRunProviderMaxAttempts,
  studioRunQueueJobOptions,
} from '../studio-run-authorize.mjs'
import { runImageQcLoop } from '../image-qc.mjs'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  delete process.env.APP_URL
  delete process.env.AGENT_INTERNAL_TOKEN
})

function appAuth(responseForRequest) {
  process.env.APP_URL = 'https://app.example'
  process.env.AGENT_INTERNAL_TOKEN = 'internal-test-token'
  const requests = []
  globalThis.fetch = async (url, init) => {
    const request = {
      url: String(url),
      init,
      body: JSON.parse(String(init?.body ?? '{}')),
    }
    requests.push(request)
    const response = responseForRequest(request)
    return Response.json(response, {
      status: response.authorized ? 200 : 409,
    })
  }
  return requests
}

test('unsigned jobs always ask the app to verify the historical row boundary', async () => {
  assert.deepEqual(classifyStudioRunAuthorization({
    provider: 'gemini',
    creativeStudio: true,
  }), { kind: 'unsigned_candidate', v3Marked: false })
  const requests = appAuth(() => ({
    authorized: true,
    legacy: true,
    compatibilityReason: 'pre_receipt_job_before_cutoff',
  }))
  const result = await authorizeStudioRunExecution('historical-job', {
    provider: 'gemini',
    creativeStudio: true,
  })
  assert.equal(result.legacy, true)
  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0].body, { pendingActionId: 'historical-job' })
})

test('new unsigned and V3-marker-only jobs fail closed from the authoritative app', async () => {
  const requests = appAuth(() => ({
    authorized: false,
    error: 'unsigned_generation_authorization_required',
  }))
  for (const payload of [
    { provider: 'gemini', creativeStudio: true },
    { provider: 'fal', studioSurface: 'v3' },
    { provider: 'fal', studioRunScope: { projectId: 'project-1' } },
    { provider: 'fal', studioPaidAttemptLimit: 2 },
    {
      provider: 'gemini',
      studioSurface: 'v3',
      _veoOperation: { name: 'retry-preserves-v3-marker' },
    },
  ]) {
    const result = await authorizeStudioRunExecution('new-unsigned-job', payload)
    assert.deepEqual(result, {
      authorized: false,
      error: 'unsigned_generation_authorization_required',
    })
  }
  assert.equal(requests.length, 5)
})

test('signed image and video jobs have one BullMQ attempt after a paid-call failure', () => {
  const signed = {
    studioSurface: 'v3',
    studioRunAuthorization: { receiptId: 'receipt-1' },
  }
  assert.deepEqual(studioRunQueueJobOptions(signed), { attempts: 1 })
  assert.deepEqual(studioRunQueueJobOptions({
    studioSurface: 'v3',
  }), { attempts: 1 })
  assert.equal(studioRunProviderMaxAttempts(signed, 3), 1)
  assert.deepEqual(studioRunQueueJobOptions({ provider: 'legacy' }), {})
  assert.equal(studioRunProviderMaxAttempts({ provider: 'legacy' }, 3), 3)
})

test('signed and V3 garment prep stays local/free while legacy cleanup remains explicit', () => {
  assert.equal(allowPaidGarmentPrepCleanup({
    studioRunAuthorization: { receiptId: 'receipt-1' },
  }), false)
  assert.equal(allowPaidGarmentPrepCleanup({
    studioSurface: 'v3',
  }), false)
  assert.equal(allowPaidGarmentPrepCleanup({
    provider: 'garment_prep',
  }), true)
})

test('each signed QC regeneration revalidates and cannot exceed the signed attempt budget', async () => {
  const requests = appAuth(({ body }) => (
    body.paidAttempt <= 2
      ? { authorized: true, receiptId: 'receipt-1', paidAttemptLimit: 2 }
      : { authorized: false, error: 'run_attempt_limit_exceeded' }
  ))
  const payload = {
    studioSurface: 'v3',
    studioPaidAttemptLimit: 2,
    studioRunAuthorization: { receiptId: 'receipt-1' },
  }
  await assertStudioRunPaidAttempt('job-1', payload, 1)
  await assertStudioRunPaidAttempt('job-1', payload, 2)
  await assert.rejects(
    () => assertStudioRunPaidAttempt('job-1', payload, 3),
    /studio_run_revalidation_failed:run_attempt_limit_exceeded/,
  )
  assert.deepEqual(
    requests.map((request) => request.body.paidAttempt),
    [1, 2, 3],
  )
})

test('QC regeneration stays within the aggregate signed hard cap', async () => {
  const scoreResponses = [
    { pass: false, score: { overall: 2, garment_fidelity: 2, model_preserved: 2, anatomy: 2 } },
    { pass: false, score: { overall: 3, garment_fidelity: 3, model_preserved: 3, anatomy: 3 } },
  ]
  globalThis.fetch = async () => Response.json(scoreResponses.shift())
  const supabase = {
    from() {
      return {
        select() { return this },
        eq() { return this },
        async maybeSingle() { return { data: { value: 'production' } } },
      }
    },
  }
  const paidCalls = [1]
  const unitCostBdt = 6
  const signedHardCapBdt = 12
  await runImageQcLoop({
    supabase,
    appUrl: 'https://app.example',
    token: 'internal',
    qcLevel: 'strict',
    initialPath: 'generated/first.png',
    maxPaidGenerations: 2,
    regenerate: async (_hint, attempt) => {
      paidCalls.push(attempt)
      return `generated/qc-${attempt}.png`
    },
  })
  assert.deepEqual(paidCalls, [1, 2])
  assert.ok(paidCalls.length * unitCostBdt <= signedHardCapBdt)
})
