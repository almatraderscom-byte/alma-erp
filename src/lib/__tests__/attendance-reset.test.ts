import { beforeEach, describe, expect, it, vi } from 'vitest'

const attendanceFindUnique = vi.fn()
const ledgerFindUnique = vi.fn()
const waiverDeleteMany = vi.fn()
const selfieDeleteMany = vi.fn()
const attendanceDelete = vi.fn()
const createCompensationLedgerEntry = vi.fn()

vi.mock('@/lib/prisma', () => ({
  prisma: {
    attendanceRecord: {
      findUnique: (...args: unknown[]) => attendanceFindUnique(...args),
      delete: (...args: unknown[]) => attendanceDelete(...args),
    },
    employeeLedgerEntry: { findUnique: (...args: unknown[]) => ledgerFindUnique(...args) },
    attendanceWaiverRequest: { deleteMany: (...args: unknown[]) => waiverDeleteMany(...args) },
    attendanceSelfieVerification: { deleteMany: (...args: unknown[]) => selfieDeleteMany(...args) },
  },
}))

vi.mock('@/lib/payroll-compensation', () => ({
  createCompensationLedgerEntry: (...args: unknown[]) => createCompensationLedgerEntry(...args),
}))

vi.mock('@/lib/logger', () => ({ logEvent: vi.fn() }))

import { resetAttendanceRecordByAdmin } from '@/lib/attendance-reset'

describe('resetAttendanceRecordByAdmin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ledgerFindUnique.mockResolvedValue(null)
    createCompensationLedgerEntry.mockResolvedValue({ id: 'reset-credit' })
    waiverDeleteMany.mockResolvedValue({ count: 0 })
    selfieDeleteMany.mockResolvedValue({ count: 0 })
    attendanceDelete.mockResolvedValue({ id: 'attendance-1' })
  })

  it('links the reset credit to the exact late-penalty ledger row', async () => {
    attendanceFindUnique.mockResolvedValue({
      id: 'attendance-1',
      isArchived: false,
      employeeId: 'EMP-1',
      businessId: 'ALMA_LIFESTYLE',
      attendanceDate: new Date('2026-08-01T00:00:00.000Z'),
      penaltyAmount: 100,
      penaltyLedgerEntryId: 'fine-late-1',
      waiverRequests: [],
      selfieVerifications: [],
    })

    await resetAttendanceRecordByAdmin('attendance-1', 'admin-1')

    expect(createCompensationLedgerEntry).toHaveBeenCalledWith(expect.objectContaining({
      source: 'attendance_reset_reversal',
      relatedEntryId: 'fine-late-1',
      amount: 100,
    }))
  })
})
