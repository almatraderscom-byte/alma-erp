import { AsyncLocalStorage } from 'async_hooks'
import {
  assertStudioRunJobPayload,
  fingerprintStudioRunValue,
  signStudioRunJobPayload,
  type StudioRunEstimateReceiptClaims,
} from '@/lib/creative-studio/studio-run-authorization'

export type StudioRunExecutionContext = {
  claims: StudioRunEstimateReceiptClaims
  receipt: string
  idempotencyKey: string
  nextJobIndex: number
}

const storage = new AsyncLocalStorage<StudioRunExecutionContext>()

export async function withStudioRunExecutionContext<T>(
  context: Omit<StudioRunExecutionContext, 'nextJobIndex'>,
  run: () => Promise<T>,
): Promise<T> {
  return storage.run({ ...context, nextJobIndex: 0 }, run)
}

export function requireStudioRunExecutionContext(): StudioRunExecutionContext {
  const context = storage.getStore()
  if (!context) throw new Error('studio_run_authorization_required')
  return context
}

export function currentStudioRunExecutionContext(): StudioRunExecutionContext | null {
  return storage.getStore() ?? null
}

export function studioRunAuthorizedJobFields(
  payload: Record<string, unknown>,
  options: { dedupePart?: string; claims?: StudioRunEstimateReceiptClaims; receipt?: string } = {},
) {
  const current = storage.getStore()
  const claims = options.claims ?? current?.claims
  const receipt = options.receipt ?? current?.receipt
  if (!claims || !receipt) throw new Error('studio_run_authorization_required')
  const index = current ? current.nextJobIndex++ : 0
  const dedupePart = options.dedupePart ?? String(index)
  const boundedPayload = {
    ...payload,
    studioPaidAttemptLimit: claims.selection.paidAttemptLimit,
    studioRunScope: claims.scope,
    studioSurface: 'v3',
  }
  const signedJob = signStudioRunJobPayload(claims.receiptId, boundedPayload)
  return {
    dedupeKey: `studio-run:${claims.receiptId}:${dedupePart}`.slice(0, 190),
    payload: {
      ...boundedPayload,
      studioRunAuthorization: {
        receipt,
        receiptId: claims.receiptId,
        requestFingerprint: claims.requestFingerprint,
        selectionFingerprint: claims.selectionFingerprint,
        estimateBdt: claims.estimateBdt,
        maxCostBdt: claims.maxCostBdt,
        scope: claims.scope,
        selection: claims.selection,
        ...signedJob,
      },
    },
  }
}

/**
 * Crash-recovery fast path for a receipt-indexed row that was fully authorized
 * before the request died. The persisted row is the exact manifest entry:
 * constructors may choose scenes non-deterministically, so a retry verifies
 * the row's own HMAC and receipt/scope claims instead of comparing it with a
 * newly randomized payload. Nothing is rewritten and no second gate runs.
 */
export function recoveredStudioRunJobId(input: {
  existing: unknown
  dedupeKey: string
  payload: Record<string, unknown>
}): string | null {
  if (!input.existing || typeof input.existing !== 'object') return null
  const row = input.existing as Record<string, unknown>
  const existingPayload = row.payload && typeof row.payload === 'object'
    ? row.payload as Record<string, unknown>
    : {}
  const existingAuthorization =
    existingPayload.studioRunAuthorization
    && typeof existingPayload.studioRunAuthorization === 'object'
      ? existingPayload.studioRunAuthorization as Record<string, unknown>
      : {}
  const expectedAuthorization =
    input.payload.studioRunAuthorization
    && typeof input.payload.studioRunAuthorization === 'object'
      ? input.payload.studioRunAuthorization as Record<string, unknown>
      : {}
  if (!existingAuthorization.receiptId) {
    if (
      row.status === 'pending'
      && row.dedupeKey === input.dedupeKey
      && typeof row.id === 'string'
    ) {
      return null
    }
    throw new Error('studio_run_recovery_job_mismatch')
  }
  if (
    row.status !== 'approved'
    || row.dedupeKey !== input.dedupeKey
    || existingAuthorization.receiptId !== expectedAuthorization.receiptId
    || existingAuthorization.requestFingerprint
      !== expectedAuthorization.requestFingerprint
    || existingAuthorization.selectionFingerprint
      !== expectedAuthorization.selectionFingerprint
    || Number(existingAuthorization.estimateBdt)
      !== Number(expectedAuthorization.estimateBdt)
    || Number(existingAuthorization.maxCostBdt)
      !== Number(expectedAuthorization.maxCostBdt)
    || typeof row.id !== 'string'
  ) {
    throw new Error('studio_run_recovery_job_mismatch')
  }
  const {
    studioRunAuthorization: _existingAuthorization,
    ...existingBoundedPayload
  } = existingPayload
  assertStudioRunJobPayload({
    receiptId: String(existingAuthorization.receiptId),
    payload: existingBoundedPayload,
    jobFingerprint: existingAuthorization.jobFingerprint,
    providedSignature: existingAuthorization.jobSignature,
  })
  if (
    fingerprintStudioRunValue(existingPayload.studioRunScope)
      !== fingerprintStudioRunValue(input.payload.studioRunScope)
    || Number(existingPayload.studioPaidAttemptLimit)
      !== Number(input.payload.studioPaidAttemptLimit)
  ) {
    throw new Error('studio_run_recovery_job_mismatch')
  }
  return row.id
}
