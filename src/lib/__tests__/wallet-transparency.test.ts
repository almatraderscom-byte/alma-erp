import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FineAppealInfo } from '@/lib/wallet-transparency'
const waiverFindMany = vi.fn()
const recordFindMany = vi.fn()

vi.mock('@/lib/prisma', () => ({
  prisma: {
    attendanceWaiverRequest: { findMany: (...args: unknown[]) => waiverFindMany(...args) },
    attendanceRecord: { findMany: (...args: unknown[]) => recordFindMany(...args) },
  },
}))

import {
  fineWindowSummary,
  mapFineAppeals,
  reconcilePenaltyAppealRefund,
} from '@/lib/wallet-transparency'

function appeal(overrides: Partial<FineAppealInfo> = {}): FineAppealInfo {
  return {
    status: 'APPROVED',
    appealable: false,
    deadline: '2026-08-31T00:00:00.000Z',
    daysLeft: 0,
    waiverId: 'waiver-1',
    attendanceRecordId: 'attendance-1',
    refundEntryId: 'refund-1',
    refundedAmount: 500,
    requestedReductionAmount: 500,
    approvedReductionAmount: 500,
    finalPenaltyAmount: 0,
    requestType: 'FULL_WAIVE',
    reason: 'Approved field work',
    adminNote: 'Office duty verified',
    reviewerName: 'Super Admin',
    reviewedAt: '2026-08-02T00:00:00.000Z',
    refundReconciled: true,
    refundIssue: null,
    ...overrides,
  }
}

describe('fineWindowSummary', () => {
  const entries = [
    { id: 'fine-1', type: 'PENALTY', source: 'attendance_no_checkout_fine', amount: 500, date: new Date('2026-07-31T00:00:00.000Z'), relatedEntryId: null },
    { id: 'refund-1', type: 'ADJUSTMENT', source: 'attendance_late_penalty_reversal', amount: 500, date: new Date('2026-08-02T00:00:00.000Z'), relatedEntryId: 'fine-1' },
    { id: 'exception-1', type: 'ADJUSTMENT', source: 'attendance_exception_refund', amount: 100, date: new Date('2026-07-31T00:00:00.000Z'), relatedEntryId: 'other-fine' },
    { id: 'reset-1', type: 'ADJUSTMENT', source: 'attendance_reset_reversal', amount: 50, date: new Date('2026-07-31T00:00:00.000Z'), relatedEntryId: 'another-fine' },
  ] as never

  it('attributes an appeal refund to the original fine window, not the later credit date', () => {
    const summary = fineWindowSummary(
      entries,
      { 'fine-1': appeal() },
      new Date('2026-07-01T00:00:00.000Z'),
      new Date('2026-07-31T23:59:59.999Z'),
    )
    expect(summary).toMatchObject({
      fineCount: 1,
      fineTotal: 500,
      refundCount: 1,
      refundTotal: 500,
      netFineCost: 0,
    })
  })

  it('keeps appeal metrics separate while net cost follows posted ledger credits', () => {
    const summary = fineWindowSummary(entries, {}, null, null)
    expect(summary.refundCount).toBe(0)
    expect(summary.refundTotal).toBe(0)
    expect(summary.netFineCost).toBe(0)
  })

  it('subtracts exact permission and reset reversals from net fine cost', () => {
    const summary = fineWindowSummary([
      { id: 'fine-exception', type: 'PENALTY', source: 'attendance_late_penalty', amount: 100, date: new Date('2026-07-31T00:00:00.000Z'), relatedEntryId: null },
      { id: 'fine-reset', type: 'PENALTY', source: 'attendance_no_checkout_fine', amount: 50, date: new Date('2026-07-31T00:00:00.000Z'), relatedEntryId: null },
      { id: 'exception-refund', type: 'ADJUSTMENT', source: 'attendance_exception_refund', amount: 100, date: new Date('2026-08-02T00:00:00.000Z'), relatedEntryId: 'fine-exception' },
      { id: 'reset-refund', type: 'ADJUSTMENT', source: 'attendance_reset_reversal', amount: 50, date: new Date('2026-08-02T00:00:00.000Z'), relatedEntryId: 'fine-reset' },
    ] as never, {}, null, null)
    expect(summary).toMatchObject({
      fineCount: 2,
      fineTotal: 150,
      refundCount: 0,
      refundTotal: 0,
      netFineCost: 0,
    })
  })

  it('does not claim a refund when the linked credit fails reconciliation', () => {
    const summary = fineWindowSummary(entries, {
      'fine-1': appeal({ refundedAmount: 0, refundReconciled: false, refundIssue: 'missing' }),
    }, null, null)
    expect(summary.refundCount).toBe(0)
    expect(summary.refundTotal).toBe(0)
  })
})

describe('reconcilePenaltyAppealRefund', () => {
  const approved = {
    status: 'APPROVED',
    approvedReductionAmount: 500,
    reversalLedgerEntryId: 'refund-1',
  } as never

  it('does not label a missing adjustment as a completed wallet refund', () => {
    expect(reconcilePenaltyAppealRefund(approved, 'fine-1', new Map())).toEqual({
      refundedAmount: 0,
      refundReconciled: false,
      refundIssue: 'Approved refund ledger entry is missing.',
    })
  })

  it('reports the actual ledger amount when it differs from the decision', () => {
    const entries = new Map([['refund-1', {
      id: 'refund-1', type: 'ADJUSTMENT', amount: 250,
      source: 'attendance_late_penalty_reversal', relatedEntryId: 'fine-1',
    }]]) as never
    expect(reconcilePenaltyAppealRefund(approved, 'fine-1', entries)).toMatchObject({
      refundedAmount: 250,
      refundReconciled: false,
    })
  })
})

describe('mapFineAppeals — same-day fine isolation', () => {
  const fineRows = [
    { id: 'late-50', type: 'PENALTY', date: new Date('2026-08-01T00:00:00Z'), employeeId: 'EMP-1', businessId: 'ALMA_LIFESTYLE', amount: 50, source: 'attendance_late_penalty', relatedEntryId: null },
    { id: 'early-50', type: 'PENALTY', date: new Date('2026-08-01T00:00:00Z'), employeeId: 'EMP-1', businessId: 'ALMA_LIFESTYLE', amount: 50, source: 'attendance_early_leave_penalty', relatedEntryId: null },
    { id: 'no-checkout-500', type: 'PENALTY', date: new Date('2026-08-01T00:00:00Z'), employeeId: 'EMP-1', businessId: 'ALMA_LIFESTYLE', amount: 500, source: 'attendance_no_checkout_fine', relatedEntryId: null },
  ] as never

  const record = {
    id: 'attendance-1',
    penaltyAmount: 50,
    penaltyLedgerEntryId: 'late-50',
    earlyLeavePenaltyAmount: 50,
    earlyLeavePenaltyLedgerEntryId: 'early-50',
    noCheckoutFineAmount: 500,
    noCheckoutFineLedgerEntryId: 'no-checkout-500',
  }

  beforeEach(() => {
    waiverFindMany.mockReset()
    recordFindMany.mockReset()
    recordFindMany.mockResolvedValue([record])
  })

  it('puts an exact appeal only on its selected no-checkout ledger row', async () => {
    waiverFindMany.mockResolvedValue([{
      id: 'waiver-noco', status: 'PENDING', requestType: 'FULL_WAIVE', reason: 'Field work',
      adminNote: null, reviewedAt: null, reversalLedgerEntryId: null,
      penaltyLedgerEntryId: 'no-checkout-500', attendanceRecordId: 'attendance-1',
      requestedReductionAmount: 500, approvedReductionAmount: null, originalPenaltyAmount: 500,
      reviewer: null,
    }])
    const result = await mapFineAppeals(fineRows, new Date('2026-08-02T00:00:00Z'))
    expect(result['no-checkout-500'].waiverId).toBe('waiver-noco')
    expect(result['late-50'].waiverId).toBeNull()
    expect(result['early-50'].waiverId).toBeNull()
  })

  it('maps a uniquely identifiable legacy appeal to only its matching amount', async () => {
    waiverFindMany.mockResolvedValue([{
      id: 'legacy-noco', status: 'REJECTED', requestType: 'FULL_WAIVE', reason: 'Legacy',
      adminNote: 'Not approved', reviewedAt: new Date('2026-08-02T00:00:00Z'), reversalLedgerEntryId: null,
      penaltyLedgerEntryId: null, attendanceRecordId: 'attendance-1',
      requestedReductionAmount: 500, approvedReductionAmount: null, originalPenaltyAmount: 500,
      reviewer: { name: 'Admin' },
    }])
    const result = await mapFineAppeals(fineRows, new Date('2026-08-02T00:00:00Z'))
    expect(result['no-checkout-500'].waiverId).toBe('legacy-noco')
    expect(result['late-50'].waiverId).toBeNull()
    expect(result['early-50'].waiverId).toBeNull()
  })

  it('never fans an ambiguous same-amount legacy appeal across two fines', async () => {
    waiverFindMany.mockResolvedValue([{
      id: 'legacy-ambiguous', status: 'PENDING', requestType: 'FULL_WAIVE', reason: 'Legacy',
      adminNote: null, reviewedAt: null, reversalLedgerEntryId: null,
      penaltyLedgerEntryId: null, attendanceRecordId: 'attendance-1',
      requestedReductionAmount: 50, approvedReductionAmount: null, originalPenaltyAmount: 50,
      reviewer: null,
    }])
    const result = await mapFineAppeals(fineRows, new Date('2026-08-02T00:00:00Z'))
    expect(result['late-50'].waiverId).toBeNull()
    expect(result['early-50'].waiverId).toBeNull()
    expect(result['no-checkout-500'].waiverId).toBeNull()
  })
})
