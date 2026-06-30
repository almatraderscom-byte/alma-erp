import { describe, it, expect, vi, beforeEach } from 'vitest'

// hasApprovedException reads one AttendanceException row via prisma. Mock the
// client so the test exercises the SCOPE rule: a LATE_ARRIVAL waiver must not
// unlock an early checkout, while FULL_DAY / EARLY_CHECKOUT must.
const findUnique = vi.fn()
vi.mock('@/lib/prisma', () => ({
  prisma: { attendanceException: { findUnique: (...a: unknown[]) => findUnique(...a) } },
}))

import { hasApprovedException, normalizeExceptionScope } from '@/lib/attendance-exception'

const ARGS = ['user-1', 'ALMA_LIFESTYLE', new Date('2026-06-30T00:00:00Z'), new Date('2026-06-30T13:55:00Z')] as const

function approvedRow(scope: string) {
  return { status: 'APPROVED', scope, startMinutes: null, endMinutes: null }
}

describe('normalizeExceptionScope', () => {
  it('keeps the three known scopes', () => {
    expect(normalizeExceptionScope('EARLY_CHECKOUT')).toBe('EARLY_CHECKOUT')
    expect(normalizeExceptionScope('late_arrival')).toBe('LATE_ARRIVAL')
    expect(normalizeExceptionScope('FULL_DAY')).toBe('FULL_DAY')
  })
  it('falls back to FULL_DAY for unknown / empty values (legacy rows)', () => {
    expect(normalizeExceptionScope(undefined)).toBe('FULL_DAY')
    expect(normalizeExceptionScope('garbage')).toBe('FULL_DAY')
  })
})

describe('hasApprovedException — scope gates the checkout waiver', () => {
  beforeEach(() => findUnique.mockReset())

  it('FULL_DAY waives checkout (legacy default behaviour)', async () => {
    findUnique.mockResolvedValue(approvedRow('FULL_DAY'))
    expect(await hasApprovedException(...ARGS)).toBe(true)
  })

  it('EARLY_CHECKOUT waives checkout', async () => {
    findUnique.mockResolvedValue(approvedRow('EARLY_CHECKOUT'))
    expect(await hasApprovedException(...ARGS)).toBe(true)
  })

  it('LATE_ARRIVAL does NOT waive checkout (the bug fix)', async () => {
    findUnique.mockResolvedValue(approvedRow('LATE_ARRIVAL'))
    expect(await hasApprovedException(...ARGS)).toBe(false)
  })

  it('a non-approved row never waives', async () => {
    findUnique.mockResolvedValue({ status: 'PENDING', scope: 'FULL_DAY', startMinutes: null, endMinutes: null })
    expect(await hasApprovedException(...ARGS)).toBe(false)
  })
})
