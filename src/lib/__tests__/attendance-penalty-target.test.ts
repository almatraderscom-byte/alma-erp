import { describe, expect, it } from 'vitest'
import { attendancePenaltyTargets, resolveAttendancePenaltyTarget } from '@/lib/attendance-penalty-target'

const record = {
  penaltyAmount: 50,
  penaltyLedgerEntryId: 'late-50',
  lateMinutes: 10,
  earlyLeavePenaltyAmount: 50,
  earlyLeavePenaltyLedgerEntryId: 'early-50',
  earlyLeaveMinutes: 20,
  noCheckoutFineAmount: 500,
  noCheckoutFineLedgerEntryId: 'no-checkout-500',
}

describe('attendance penalty identity', () => {
  it('keeps each same-day fine as an independent target', () => {
    expect(attendancePenaltyTargets(record).map(row => row.ledgerEntryId)).toEqual([
      'late-50', 'early-50', 'no-checkout-500',
    ])
  })

  it('resolves an exact link even when two fines have the same amount', () => {
    expect(resolveAttendancePenaltyTarget(record, 'early-50', 50)).toMatchObject({
      kind: 'EARLY_LEAVE', ledgerEntryId: 'early-50', minutes: 20,
    })
  })

  it('refuses to guess an ambiguous legacy same-amount appeal', () => {
    expect(resolveAttendancePenaltyTarget(record, null, 50)).toBeNull()
  })

  it('safely infers a unique legacy no-checkout appeal', () => {
    expect(resolveAttendancePenaltyTarget(record, null, 500)).toMatchObject({
      kind: 'NO_CHECKOUT', ledgerEntryId: 'no-checkout-500', amount: 500,
    })
  })
})
