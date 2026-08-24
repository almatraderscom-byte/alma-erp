import { UnrecoverableError } from 'bullmq'

export const SEO_JOB_RESULT_RECEIPT_KEY = '__seoJobResultReceipt'

const retryableHttpStatus = (status) =>
  status === 408 || status === 425 || status === 429 || status >= 500

const receiptIdFor = (pendingActionId) => `seo-job-result:${pendingActionId}:v1`

const errorDetail = (error, fallback) => {
  const detail = error instanceof Error ? error.message : String(error ?? '')
  return detail.trim().slice(0, 500) || fallback
}

export class SeoJobResultRetryableError extends Error {
  constructor(code, status = null) {
    super(code)
    this.name = 'SeoJobResultRetryableError'
    this.status = status
  }
}

export function makeSeoJobResultReceipt(
  pendingActionId,
  status,
  data,
  error,
  recordedAt = new Date().toISOString(),
) {
  if (!pendingActionId) throw new Error('missing_seo_pending_action_id')
  if (status !== 'success' && status !== 'failed') throw new Error('invalid_seo_job_result_status')
  return {
    version: 1,
    receiptId: receiptIdFor(pendingActionId),
    pendingActionId,
    status,
    ...(data && typeof data === 'object' ? { data } : {}),
    ...(typeof error === 'string' && error ? { error } : {}),
    recordedAt,
  }
}

export function readSeoJobResultReceipt(value) {
  const receipt = value?.[SEO_JOB_RESULT_RECEIPT_KEY]
    ?? (value?.version === 1 && typeof value?.receiptId === 'string' ? value : null)
  if (!receipt || receipt.version !== 1) return null
  if (receipt.status !== 'success' && receipt.status !== 'failed') return null
  if (typeof receipt.pendingActionId !== 'string' || !receipt.pendingActionId) return null
  if (receipt.receiptId !== receiptIdFor(receipt.pendingActionId)) return null
  if (typeof receipt.recordedAt !== 'string' || !Number.isFinite(Date.parse(receipt.recordedAt))) return null
  return receipt
}

async function persistSeoJobResultReceipt(job, receipt) {
  if (!job || typeof job.updateData !== 'function') throw new Error('seo_job_result_job_not_persistable')
  const data = { ...job.data, [SEO_JOB_RESULT_RECEIPT_KEY]: receipt }
  // BullMQ stores updateData in Redis. The processor must not contact the app
  // until this succeeds, so a process restart can replay the exact source fact.
  await job.updateData(data)
  job.data = data
}

/**
 * Make one callback attempt. Retryable failures reject normally so BullMQ keeps
 * the job non-terminal; permanent 4xx responses use UnrecoverableError so they
 * do not burn the entire retry budget. Error messages intentionally contain no
 * response body, URL, headers, or credential material.
 */
export async function deliverSeoJobResultReceipt(receiptValue, options = {}) {
  const receipt = readSeoJobResultReceipt(receiptValue)
  if (!receipt) throw new UnrecoverableError('invalid_seo_job_result_receipt')

  const appUrl = String(options.appUrl ?? '').trim().replace(/\/$/, '')
  const token = String(options.token ?? '')
  if (!appUrl || !token) throw new UnrecoverableError('seo_job_result_delivery_unconfigured')

  const fetchImpl = options.fetchImpl ?? fetch
  let response
  try {
    response = await fetchImpl(`${appUrl}/api/assistant/internal/job-result`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(options.protectionHeaders ?? {}),
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        pendingActionId: receipt.pendingActionId,
        status: receipt.status,
        data: receipt.data,
        error: receipt.error,
        receiptId: receipt.receiptId,
      }),
      signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 15_000),
    })
  } catch {
    throw new SeoJobResultRetryableError('seo_job_result_transport_failed')
  }

  if (response.ok) return { acknowledged: true, status: response.status, receiptId: receipt.receiptId }
  if (retryableHttpStatus(response.status)) {
    throw new SeoJobResultRetryableError(`seo_job_result_http_${response.status}_retryable`, response.status)
  }
  throw new UnrecoverableError(`seo_job_result_http_${response.status}_unrecoverable`)
}

/**
 * Build and publish an SEO audit exactly once, persist its terminal source fact
 * in BullMQ, then deliver it. A retried/restarted processor sees the receipt
 * first and performs callback-only recovery (no recrawl and no re-upload).
 */
export async function processSeoAuditJob(job, deps) {
  let receipt = readSeoJobResultReceipt(job?.data)
  const replayed = Boolean(receipt)

  if (!receipt) {
    const pendingActionId = job?.data?.pendingActionId
    const payload = job?.data?.payload
    let result
    try {
      result = await deps.runSeoAudit(payload)
    } catch (error) {
      deps.onSourceError?.(error, 'audit')
      receipt = makeSeoJobResultReceipt(
        pendingActionId,
        'failed',
        undefined,
        errorDetail(error, 'seo_audit_crashed'),
      )
    }

    if (!receipt && !result?.ok) {
      receipt = makeSeoJobResultReceipt(
        pendingActionId,
        'failed',
        undefined,
        errorDetail(result?.error, 'seo_audit_failed'),
      )
    }

    if (!receipt) {
      const base = `seo-audits/${pendingActionId}`
      const artifacts = []
      try {
        await deps.uploadArtifact({
          path: `${base}/report.md`,
          body: Buffer.from(result.reportMarkdown, 'utf8'),
          contentType: 'text/markdown',
        })
        artifacts.push(`${base}/report.md`)
        await deps.uploadArtifact({
          path: `${base}/audit.json`,
          body: Buffer.from(JSON.stringify(result.auditJson), 'utf8'),
          contentType: 'application/json',
        })
        artifacts.push(`${base}/audit.json`)
        receipt = makeSeoJobResultReceipt(pendingActionId, 'success', {
          score: result.score,
          counts: result.counts,
          pagesCrawled: result.pagesCrawled,
          avgTtfbMs: result.avgTtfbMs,
          artifacts,
          reportPreview: result.reportMarkdown.slice(0, 1500),
        })
      } catch (error) {
        deps.onSourceError?.(error, 'artifact_upload')
        receipt = makeSeoJobResultReceipt(
          pendingActionId,
          'failed',
          { score: result.score },
          `artifact upload failed: ${errorDetail(error, 'unknown_error')}`,
        )
      }
    }

    await persistSeoJobResultReceipt(job, receipt)
  }

  await deps.deliverResult(receipt)
  return { receipt, replayed }
}
