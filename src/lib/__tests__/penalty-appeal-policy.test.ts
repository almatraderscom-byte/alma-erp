import { describe, expect, it } from 'vitest'
import { formatPenaltyAppealTelegramMessage } from '@/lib/penalty-appeal-telegram'
import {
  isFineAppealable,
  normalizePenaltyReviewNote,
  resolveApprovedPenaltyReduction,
  resolvePenaltyTarget,
  resolveRequestedPenaltyReduction,
} from '@/lib/penalty-appeal-policy'

describe('penalty appeal policy', () => {
  it('binds a no-checkout appeal to the selected ৳500 ledger entry', () => {
    expect(resolvePenaltyTarget(['late-50', 'no-checkout-500'], 'no-checkout-500')).toEqual({
      ok: true,
      penaltyLedgerEntryId: 'no-checkout-500',
    })
  })

  it('does not guess between multiple penalties on the same attendance day', () => {
    expect(resolvePenaltyTarget(['late-50', 'no-checkout-500'])).toEqual({
      ok: false,
      reason: 'MISSING_SELECTION',
    })
  })

  it('keeps rejected and cancelled penalties non-appealable', () => {
    expect(isFineAppealable(true, true)).toBe(false)
    expect(isFineAppealable(true, false)).toBe(true)
  })

  it('rejects a blank partial amount before it can consume the once-only appeal', () => {
    expect(resolveRequestedPenaltyReduction(500, 0)).toEqual({
      ok: false,
      reason: 'AMOUNT_REQUIRED',
    })
  })

  it('accepts a valid partial staff request within the exact fine', () => {
    expect(resolveRequestedPenaltyReduction(500, 250)).toEqual({ ok: true, amount: 250 })
  })

  it('formats the selected amount without substituting the late fine', () => {
    const message = formatPenaltyAppealTelegramMessage({
      employeeName: 'Employee',
      employeeId: 'EMP-51',
      penaltyAmount: 500,
      requestedReduction: 500,
      requestType: 'FULL_WAIVE',
      reason: 'Approved field work',
    })
    expect(message).toContain('৳ 500')
    expect(message).not.toMatch(/৳ 50(?:\D|$)/)
  })

  it('allows an approval without forcing a human rationale', () => {
    expect(normalizePenaltyReviewNote('APPROVE', '')).toEqual({ ok: true, note: null })
  })

  it('lets the reviewer turn a full request into an exact partial wallet credit', () => {
    expect(resolveApprovedPenaltyReduction(500, 500, 250)).toEqual({
      ok: true,
      amount: 250,
      outcome: 'PARTIALLY_APPROVED',
      remainingPenalty: 250,
    })
  })

  it('keeps full approval explicit when the exact fine is fully credited', () => {
    expect(resolveApprovedPenaltyReduction(500, 500, 500)).toEqual({
      ok: true,
      amount: 500,
      outcome: 'FULLY_APPROVED',
      remainingPenalty: 0,
    })
  })

  it('rejects an amount above the staff request instead of silently clamping it', () => {
    expect(resolveApprovedPenaltyReduction(500, 250, 300)).toEqual({
      ok: false,
      reason: 'EXCEEDS_REQUESTED_AMOUNT',
    })
  })

  it('defaults a legacy approval to the requested amount', () => {
    expect(resolveApprovedPenaltyReduction(500, 250)).toEqual({
      ok: true,
      amount: 250,
      outcome: 'PARTIALLY_APPROVED',
      remainingPenalty: 250,
    })
  })

  it('requires a useful rejection reason and trims accepted notes', () => {
    expect(normalizePenaltyReviewNote('REJECT', 'no')).toEqual({
      ok: false,
      reason: 'REJECTION_REASON_REQUIRED',
    })
    expect(normalizePenaltyReviewNote('REJECT', '  Not eligible  ')).toEqual({
      ok: true,
      note: 'Not eligible',
    })
  })
})
