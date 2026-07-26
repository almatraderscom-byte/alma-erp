import { getAppUrl, getInternalToken } from './env.mjs'

/**
 * Revalidate a V3 paid run against the authoritative app immediately before
 * provider execution. The worker never decides whether an unsigned row is
 * historical: every unsigned candidate goes to the app, which checks the
 * pending action's persisted type/status/createdAt against an immutable
 * cutoff. Payload markers and the worker clock are not compatibility authority.
 */
export function classifyStudioRunAuthorization(payload) {
  if (payload?.studioRunAuthorization) return { kind: 'signed' }
  return {
    kind: 'unsigned_candidate',
    v3Marked: Boolean(
    payload?.studioSurface === 'v3'
    || payload?.studioRunScope
    || payload?.studioPaidAttemptLimit != null,
    ),
  }
}

/**
 * BullMQ's queue defaults intentionally remain unchanged for historical jobs.
 * A V3 marker means the handler may perform paid work under a signed aggregate
 * attempt budget, so the queue itself must never replay that budget after a
 * post-provider failure. QC retries happen inside the one handler invocation
 * and are bounded by `studioPaidAttemptLimit`.
 */
export function studioRunQueueJobOptions(payload) {
  const classification = classifyStudioRunAuthorization(payload)
  return classification.kind === 'signed' || classification.v3Marked
    ? { attempts: 1 }
    : {}
}

/** Paid HTTP clients may retain historical transient retries only off V3. */
export function studioRunProviderMaxAttempts(payload, legacyMaxAttempts) {
  const legacyMax = Math.max(1, Math.trunc(Number(legacyMaxAttempts) || 1))
  const classification = classifyStudioRunAuthorization(payload)
  return classification.kind === 'signed' || classification.v3Marked
    ? 1
    : legacyMax
}

/**
 * Adapter-level revalidation is mandatory for V3 and signed work. Historical
 * unsigned actions are authorized once by the top-level worker handler using
 * their persisted server row; keeping this predicate here prevents direct
 * adapter tests or legacy in-flight jobs from inventing worker-side history.
 */
export function requiresStudioRunPaidAttemptAuthorization(payload) {
  const classification = classifyStudioRunAuthorization(payload)
  return classification.kind === 'signed' || classification.v3Marked
}

/**
 * Garment prep is signed as a local/free step. Its legacy cleanup path can
 * invoke Gemini detection and FLUX inpaint, so signed/V3 jobs must never make
 * that option reachable.
 */
export function allowPaidGarmentPrepCleanup(payload) {
  return !requiresStudioRunPaidAttemptAuthorization(payload)
}

export async function authorizeStudioRunExecution(pendingActionId, payload, options = {}) {
  const res = await fetch(`${getAppUrl()}/api/assistant/internal/studio-run-authorize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getInternalToken()}`,
    },
    body: JSON.stringify({
      pendingActionId,
      ...(options.paidAttempt == null ? {} : { paidAttempt: options.paidAttempt }),
    }),
    signal: AbortSignal.timeout(15_000),
  })
  const result = await res.json().catch(() => ({}))
  if (!res.ok || result.authorized !== true) {
    return {
      authorized: false,
      error: typeof result.error === 'string'
        ? result.error
        : `studio_run_revalidation_http_${res.status}`,
    }
  }
  return result
}

/**
 * Authoritative last-moment gate for an actual provider invocation. The
 * signed attempt number is checked by the app on every call. V3 has one
 * BullMQ handler attempt, so these in-handler attempt numbers are the complete
 * paid-call budget rather than a budget that can reset on queue retry.
 */
export async function assertStudioRunPaidAttempt(pendingActionId, payload, paidAttempt) {
  if (!Number.isInteger(paidAttempt) || paidAttempt < 1) {
    throw new Error('studio_paid_attempt_invalid')
  }
  const authorization = await authorizeStudioRunExecution(
    pendingActionId,
    payload,
    { paidAttempt },
  )
  if (!authorization.authorized) {
    throw new Error(`studio_run_revalidation_failed:${authorization.error}`)
  }
  if (
    authorization.legacy !== true
    && (
      !Number.isInteger(Number(authorization.paidAttemptLimit))
      || paidAttempt > Number(authorization.paidAttemptLimit)
    )
  ) {
    throw new Error('studio_paid_attempt_limit_exceeded')
  }
  return authorization
}
