import test from 'node:test'
import assert from 'node:assert/strict'
import { UnrecoverableError } from 'bullmq'
import {
  SEO_JOB_RESULT_RECEIPT_KEY,
  SeoJobResultRetryableError,
  deliverSeoJobResultReceipt,
  processSeoAuditJob,
  readSeoJobResultReceipt,
} from '../job-result.mjs'

const pendingActionId = '69f9c18b-1111-4222-8333-123456789abc'
const payload = { url: 'https://example.test' }
const auditResult = {
  ok: true,
  score: 73,
  counts: { critical: 0, high: 1, medium: 2, low: 3 },
  pagesCrawled: 12,
  avgTtfbMs: 184,
  reportMarkdown: '# Durable SEO report\n\nEvidence.',
  auditJson: { url: payload.url, pages: [{ url: `${payload.url}/` }] },
}

function durableJobStore() {
  const store = { data: { pendingActionId, payload }, updateCalls: 0 }
  return {
    store,
    rehydrate() {
      return {
        id: pendingActionId,
        data: structuredClone(store.data),
        async updateData(next) {
          store.updateCalls += 1
          store.data = structuredClone(next)
          this.data = structuredClone(next)
        },
      }
    },
  }
}

test('three callback failures plus restart replay one durable SEO result and eventually acknowledge', async () => {
  const durable = durableJobStore()
  const callbackOutcomes = [503, 'transport_error', 503, 200]
  const callbackBodies = []
  const uploads = []
  let auditCalls = 0
  let finalOutcome = null

  for (let attempt = 0; attempt < callbackOutcomes.length; attempt += 1) {
    // A newly hydrated job and newly constructed deliverer model both the
    // worker and app processes restarting between BullMQ attempts.
    const job = durable.rehydrate()
    const callbackOutcome = callbackOutcomes[attempt]
    const deps = {
      runSeoAudit: async () => {
        auditCalls += 1
        return auditResult
      },
      uploadArtifact: async (artifact) => uploads.push(artifact.path),
      deliverResult: (receipt) => deliverSeoJobResultReceipt(receipt, {
        appUrl: 'https://app.example.test',
        token: 'test-credential-must-never-appear-in-errors',
        signal: new AbortController().signal,
        fetchImpl: async (_url, init) => {
          assert.ok(
            readSeoJobResultReceipt(durable.store.data),
            'source receipt must be durable before the first callback byte is sent',
          )
          callbackBodies.push(JSON.parse(init.body))
          if (callbackOutcome === 'transport_error') throw new Error('simulated_app_restart')
          return { ok: callbackOutcome === 200, status: callbackOutcome }
        },
      }),
    }

    if (attempt < 3) {
      await assert.rejects(
        processSeoAuditJob(job, deps),
        (error) => error instanceof SeoJobResultRetryableError,
      )
    } else {
      finalOutcome = await processSeoAuditJob(job, deps)
    }
  }

  assert.equal(auditCalls, 1, 'callback retry/restart must not crawl again')
  assert.deepEqual(uploads, [
    `seo-audits/${pendingActionId}/report.md`,
    `seo-audits/${pendingActionId}/audit.json`,
  ])
  assert.equal(durable.store.updateCalls, 1, 'the immutable source fact is written once')
  assert.equal(finalOutcome?.replayed, true)
  assert.equal(finalOutcome?.receipt.status, 'success')
  assert.equal(callbackBodies.length, 4)
  for (const body of callbackBodies.slice(1)) assert.deepEqual(body, callbackBodies[0])
  assert.equal(callbackBodies[0].receiptId, `seo-job-result:${pendingActionId}:v1`)
  assert.equal(
    durable.store.data[SEO_JOB_RESULT_RECEIPT_KEY].receiptId,
    callbackBodies[0].receiptId,
  )
})

test('a non-retryable callback response leaves the receipt durable and stops BullMQ retries', async () => {
  const durable = durableJobStore()
  const secret = 'test-credential-must-never-appear-in-errors'
  let callbackCalls = 0

  await assert.rejects(
    processSeoAuditJob(durable.rehydrate(), {
      runSeoAudit: async () => auditResult,
      uploadArtifact: async () => {},
      deliverResult: (receipt) => deliverSeoJobResultReceipt(receipt, {
        appUrl: 'https://app.example.test',
        token: secret,
        signal: new AbortController().signal,
        fetchImpl: async () => {
          callbackCalls += 1
          return {
            ok: false,
            status: 422,
            text: async () => {
              throw new Error('response bodies must not be read into errors or logs')
            },
          }
        },
      }),
    }),
    (error) => {
      assert.ok(error instanceof UnrecoverableError)
      assert.equal(error.message, 'seo_job_result_http_422_unrecoverable')
      assert.equal(error.message.includes(secret), false)
      return true
    },
  )

  assert.equal(callbackCalls, 1)
  assert.equal(durable.store.updateCalls, 1)
  assert.equal(readSeoJobResultReceipt(durable.store.data)?.status, 'success')
})
