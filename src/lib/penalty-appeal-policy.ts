export type PenaltyTargetResolution =
  | { ok: true; penaltyLedgerEntryId: string }
  | { ok: false; reason: 'MISSING_SELECTION' | 'NOT_LINKED_TO_ATTENDANCE' }

/**
 * Resolve the exact posted wallet penalty being appealed. A legacy client may
 * omit the id only when that attendance day has exactly one posted fine.
 */
export function resolvePenaltyTarget(
  postedPenaltyIds: Array<string | null | undefined>,
  requestedPenaltyId?: string | null,
): PenaltyTargetResolution {
  const posted = Array.from(new Set(postedPenaltyIds.filter((id): id is string => Boolean(id))))
  const requested = String(requestedPenaltyId || '').trim()
  if (requested) {
    return posted.includes(requested)
      ? { ok: true, penaltyLedgerEntryId: requested }
      : { ok: false, reason: 'NOT_LINKED_TO_ATTENDANCE' }
  }
  return posted.length === 1
    ? { ok: true, penaltyLedgerEntryId: posted[0] }
    : { ok: false, reason: 'MISSING_SELECTION' }
}

/** Once any decision-history row exists, the exact fine is no longer appealable. */
export function isFineAppealable(withinWindow: boolean, hasAppealHistory: boolean): boolean {
  return withinWindow && !hasAppealHistory
}

export const PENALTY_REJECTION_REASON_MIN_LENGTH = 5

export type ApprovedPenaltyReductionResult =
  | {
      ok: true
      amount: number
      outcome: 'FULLY_APPROVED' | 'PARTIALLY_APPROVED'
      remainingPenalty: number
    }
  | {
      ok: false
      reason: 'INVALID_AMOUNT' | 'AMOUNT_REQUIRED' | 'EXCEEDS_REQUESTED_AMOUNT' | 'EXCEEDS_ORIGINAL_PENALTY'
    }

function moneyValue(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Resolve the reviewer's exact wallet credit. The reviewer may reduce a full
 * request to half or any custom amount, but may never credit more than the
 * staff member requested or more than the exact fine being reviewed.
 *
 * This deliberately rejects bad input instead of silently clamping it. Silent
 * clamping makes the recorded decision differ from what the reviewer entered.
 */
export function resolveApprovedPenaltyReduction(
  originalPenalty: number,
  requestedReduction: number,
  rawApprovedAmount?: number | null,
): ApprovedPenaltyReductionResult {
  const original = moneyValue(Number(originalPenalty))
  const requested = moneyValue(Number(requestedReduction))
  const input = rawApprovedAmount == null ? requested : Number(rawApprovedAmount)

  if (!Number.isFinite(original) || !Number.isFinite(requested) || !Number.isFinite(input)) {
    return { ok: false, reason: 'INVALID_AMOUNT' }
  }
  if (input <= 0) return { ok: false, reason: 'AMOUNT_REQUIRED' }

  const amount = moneyValue(input)
  if (amount > original) return { ok: false, reason: 'EXCEEDS_ORIGINAL_PENALTY' }
  if (amount > requested) return { ok: false, reason: 'EXCEEDS_REQUESTED_AMOUNT' }

  const remainingPenalty = moneyValue(Math.max(0, original - amount))
  return {
    ok: true,
    amount,
    outcome: remainingPenalty === 0 ? 'FULLY_APPROVED' : 'PARTIALLY_APPROVED',
    remainingPenalty,
  }
}

export type PenaltyReviewNoteResult =
  | { ok: true; note: string | null }
  | { ok: false; reason: 'REJECTION_REASON_REQUIRED' }

/**
 * Approval is already an explicit decision and remains fully auditable through
 * reviewer, source and timestamp. A human note is therefore optional. Rejection
 * changes the staff member's outcome without relief, so it must explain why.
 */
export function normalizePenaltyReviewNote(
  action: 'APPROVE' | 'REJECT',
  rawNote: unknown,
): PenaltyReviewNoteResult {
  const note = String(rawNote || '').trim().slice(0, 1200) || null
  if (action === 'REJECT' && (!note || note.length < PENALTY_REJECTION_REASON_MIN_LENGTH)) {
    return { ok: false, reason: 'REJECTION_REASON_REQUIRED' }
  }
  return { ok: true, note }
}
