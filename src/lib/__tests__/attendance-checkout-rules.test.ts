import { describe, it, expect, vi, beforeEach } from 'vitest'

// runCheckoutGates calls into these prisma-backed helpers. Mock them so the
// test exercises the GATE LOGIC (the actual fix) without a database. Default:
// no exception, no leave — the common case where the block must hold.
vi.mock('@/lib/attendance-exception', () => ({
  hasApprovedException: vi.fn(async () => false),
}))
vi.mock('@/lib/attendance-leave', () => ({
  leaveWaivesCheckout: vi.fn(async () => false),
}))

import {
  checkoutRulesEnabled,
  checkoutTimeBlockEnabled,
  checkoutTimeGate,
  runCheckoutGates,
} from '@/lib/attendance-checkout-rules'
import { hasApprovedException } from '@/lib/attendance-exception'
import { leaveWaivesCheckout } from '@/lib/attendance-leave'

// ALMA_LIFESTYLE office end = 8:00 PM (Asia/Dhaka, UTC+6, no DST).
// 7:55 PM Dhaka == 13:55 UTC  → before close.
// 8:30 PM Dhaka == 14:30 UTC  → after close.
const BEFORE_8PM = new Date('2026-06-30T13:55:00Z')
const AFTER_8PM = new Date('2026-06-30T14:30:00Z')

describe('checkoutTimeBlockEnabled — always-on 8 PM block (Option A)', () => {
  it('is ON for ALMA_LIFESTYLE', () => {
    expect(checkoutTimeBlockEnabled('ALMA_LIFESTYLE')).toBe(true)
  })
  it('is OFF for every other business', () => {
    expect(checkoutTimeBlockEnabled('CDIT')).toBe(false)
    expect(checkoutTimeBlockEnabled('ALMA_TRADING')).toBe(false)
  })
})

describe('checkoutTimeGate', () => {
  it('blocks before 8 PM with checkout_too_early', () => {
    const r = checkoutTimeGate('ALMA_LIFESTYLE', BEFORE_8PM)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('checkout_too_early')
  })
  it('allows at/after 8 PM', () => {
    expect(checkoutTimeGate('ALMA_LIFESTYLE', AFTER_8PM).ok).toBe(true)
  })
})

describe('runCheckoutGates — production scenario (kill-switch OFF)', () => {
  beforeEach(() => {
    vi.mocked(hasApprovedException).mockResolvedValue(false)
    vi.mocked(leaveWaivesCheckout).mockResolvedValue(false)
  })

  const base = {
    businessId: 'ALMA_LIFESTYLE',
    userId: 'user-1',
    attendanceDate: new Date('2026-06-30T00:00:00Z'),
    location: null,
    enforceExtraGates: false, // production: location/task gates disabled
  }

  it('still BLOCKS an early checkout even with extra gates off (the bug fix)', async () => {
    const r = await runCheckoutGates({ ...base, now: BEFORE_8PM })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('checkout_too_early')
  })

  it('allows checkout after 8 PM (no false block / no regression)', async () => {
    const r = await runCheckoutGates({ ...base, now: AFTER_8PM })
    expect(r.ok).toBe(true)
  })

  it('an owner-approved exception waives the early-checkout block', async () => {
    vi.mocked(hasApprovedException).mockResolvedValue(true)
    const r = await runCheckoutGates({ ...base, now: BEFORE_8PM })
    expect(r.ok).toBe(true)
  })

  it('an owner-approved leave waives the early-checkout block', async () => {
    vi.mocked(leaveWaivesCheckout).mockResolvedValue(true)
    const r = await runCheckoutGates({ ...base, now: BEFORE_8PM })
    expect(r.ok).toBe(true)
  })
})

describe('checkoutRulesEnabled (extra gates) stays independent of the time block', () => {
  it('is false for non-ALMA_LIFESTYLE businesses', () => {
    expect(checkoutRulesEnabled('CDIT')).toBe(false)
  })
})
