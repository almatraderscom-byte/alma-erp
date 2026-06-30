import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AttendanceException } from '@prisma/client'

// refundFinesForApprovedException reads the attendance record and raises an
// ADJUSTMENT credit per matching fine. Mock both so the test exercises the
// SCOPE→fine mapping and the "only refund posted fines" rule.
const recordFindUnique = vi.fn<(...a: unknown[]) => unknown>()
const createEntry = vi.fn<(...a: unknown[]) => Promise<{ id: string }>>(async () => ({ id: 'ledger-x' }))

vi.mock('@/lib/prisma', () => ({
  prisma: { attendanceRecord: { findUnique: (...a: unknown[]) => recordFindUnique(...a) } },
}))
vi.mock('@/lib/payroll-compensation', () => ({
  createCompensationLedgerEntry: (...a: unknown[]) => createEntry(...a),
}))

import { refundFinesForApprovedException } from '@/lib/attendance-exception'

const baseEx = {
  id: 'exc-1',
  businessId: 'ALMA_LIFESTYLE',
  userId: 'user-1',
  employeeId: 'EMP-1',
  attendanceDate: new Date('2026-06-30T00:00:00Z'),
  reviewedById: 'owner-1',
}

function ex(scope: string): AttendanceException {
  return { ...baseEx, scope } as unknown as AttendanceException
}

// All three fines posted (ledger ids present, positive amounts).
const fullyFinedRecord = {
  penaltyAmount: 200,
  penaltyLedgerEntryId: 'l-late',
  earlyLeavePenaltyAmount: 50,
  earlyLeavePenaltyLedgerEntryId: 'l-early',
  noCheckoutFineAmount: 500,
  noCheckoutFineLedgerEntryId: 'l-noco',
}

function kindsFromCalls(): string[] {
  return createEntry.mock.calls.map(c => String((c[0] as { sourceRef: string }).sourceRef).split(':').pop() as string)
}

describe('refundFinesForApprovedException — scope decides which posted fines refund', () => {
  beforeEach(() => {
    recordFindUnique.mockReset()
    createEntry.mockClear()
  })

  it('LATE_ARRIVAL refunds only the late check-in fine', async () => {
    recordFindUnique.mockResolvedValue(fullyFinedRecord)
    await refundFinesForApprovedException(ex('LATE_ARRIVAL'))
    expect(kindsFromCalls()).toEqual(['late'])
  })

  it('EARLY_CHECKOUT refunds the early-checkout + no-checkout fines', async () => {
    recordFindUnique.mockResolvedValue(fullyFinedRecord)
    await refundFinesForApprovedException(ex('EARLY_CHECKOUT'))
    expect(kindsFromCalls().sort()).toEqual(['early', 'nocheckout'])
  })

  it('FULL_DAY refunds all three fines', async () => {
    recordFindUnique.mockResolvedValue(fullyFinedRecord)
    await refundFinesForApprovedException(ex('FULL_DAY'))
    expect(kindsFromCalls().sort()).toEqual(['early', 'late', 'nocheckout'])
  })

  it('does not refund a fine that was never posted (no ledger id / zero amount)', async () => {
    recordFindUnique.mockResolvedValue({
      penaltyAmount: 200,
      penaltyLedgerEntryId: null, // late fine raised but not posted
      earlyLeavePenaltyAmount: 0,
      earlyLeavePenaltyLedgerEntryId: null,
      noCheckoutFineAmount: 500,
      noCheckoutFineLedgerEntryId: 'l-noco',
    })
    await refundFinesForApprovedException(ex('FULL_DAY'))
    expect(kindsFromCalls()).toEqual(['nocheckout'])
  })

  it('credits the exact fine amount as an ADJUSTMENT (refund)', async () => {
    recordFindUnique.mockResolvedValue(fullyFinedRecord)
    await refundFinesForApprovedException(ex('EARLY_CHECKOUT'))
    const early = createEntry.mock.calls
      .map(c => c[0] as { sourceRef: string; type: string; amount: number })
      .find(a => a.sourceRef.endsWith(':early'))
    expect(early?.type).toBe('ADJUSTMENT')
    expect(early?.amount).toBe(50)
  })

  it('no record for the day → no refund', async () => {
    recordFindUnique.mockResolvedValue(null)
    await refundFinesForApprovedException(ex('FULL_DAY'))
    expect(createEntry).not.toHaveBeenCalled()
  })
})
