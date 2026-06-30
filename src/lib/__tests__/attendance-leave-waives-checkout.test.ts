import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AttendanceLeave } from '@prisma/client'

// leaveWaivesCheckout decides whether an approved leave excuses the checkout
// discipline gates (the 8 PM time gate + location/task). The invariant under
// test: only a leave that genuinely authorises an EARLY DEPARTURE — whole-day,
// or an HOURS window that runs through office close (8 PM = 1200 for
// ALMA_LIFESTYLE) — waives checkout. A SHIFTED_START (late morning) or a
// mid-day HOURS window must NOT let the staff skip the 8 PM checkout.
const leaveFindFirst = vi.fn<(...a: unknown[]) => Promise<unknown>>()

vi.mock('@/lib/prisma', () => ({
  prisma: {
    attendanceLeave: { findFirst: (...a: unknown[]) => leaveFindFirst(...a) },
  },
}))

import { leaveWaivesCheckout } from '@/lib/attendance-leave'

const BUSINESS = 'ALMA_LIFESTYLE' // office close 8:00 PM = 1200
const DATE = new Date('2026-06-30T00:00:00Z')

// 5:00 PM Asia/Dhaka == 11:00 UTC
const at = (h: number, m = 0) => new Date(Date.UTC(2026, 5, 30, h - 6, m))

function leave(partial: Partial<AttendanceLeave>): AttendanceLeave {
  return {
    id: 'lv-1',
    businessId: BUSINESS,
    userId: 'user-1',
    employeeId: 'EMP-1',
    kind: 'HOURS',
    startDate: DATE,
    endDate: DATE,
    startMinutes: null,
    endMinutes: null,
    status: 'APPROVED',
    ...partial,
  } as unknown as AttendanceLeave
}

describe('leaveWaivesCheckout — only a real early-departure waives the checkout gate', () => {
  beforeEach(() => {
    leaveFindFirst.mockReset()
  })

  it('no leave → does not waive', async () => {
    leaveFindFirst.mockResolvedValue(null)
    expect(await leaveWaivesCheckout('user-1', BUSINESS, DATE, at(15))).toBe(false)
  })

  it('FULL_DAY leave → always waives', async () => {
    leaveFindFirst.mockResolvedValue(leave({ kind: 'FULL_DAY' }))
    expect(await leaveWaivesCheckout('user-1', BUSINESS, DATE, at(15))).toBe(true)
  })

  it('DATE_RANGE leave → always waives', async () => {
    leaveFindFirst.mockResolvedValue(leave({ kind: 'DATE_RANGE' }))
    expect(await leaveWaivesCheckout('user-1', BUSINESS, DATE, at(15))).toBe(true)
  })

  it('SHIFTED_START (endMinutes null) → never waives checkout', async () => {
    // Begins 11:00 AM (start 660), no end — still works until 8 PM.
    leaveFindFirst.mockResolvedValue(leave({ kind: 'SHIFTED_START', startMinutes: 660, endMinutes: null }))
    expect(await leaveWaivesCheckout('user-1', BUSINESS, DATE, at(19))).toBe(false)
  })

  it('mid-day HOURS leave (1–3 PM) → does NOT waive the 8 PM checkout', async () => {
    leaveFindFirst.mockResolvedValue(leave({ startMinutes: 13 * 60, endMinutes: 15 * 60 }))
    // even when checking out inside the window
    expect(await leaveWaivesCheckout('user-1', BUSINESS, DATE, at(14))).toBe(false)
  })

  it('end-of-day HOURS leave (5 PM → 8 PM close) → waives once inside window', async () => {
    leaveFindFirst.mockResolvedValue(leave({ startMinutes: 17 * 60, endMinutes: 20 * 60 }))
    expect(await leaveWaivesCheckout('user-1', BUSINESS, DATE, at(17))).toBe(true)
  })

  it('end-of-day HOURS leave → does NOT waive before the approved window starts', async () => {
    leaveFindFirst.mockResolvedValue(leave({ startMinutes: 17 * 60, endMinutes: 20 * 60 }))
    expect(await leaveWaivesCheckout('user-1', BUSINESS, DATE, at(16))).toBe(false)
  })
})
