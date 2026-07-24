import { describe, expect, it } from 'vitest'
import {
  classifyRunway,
  computeDailyBurn,
  computeRunway,
  computeSuggestedTopUp,
  roundUsdCents,
  MIN_CONFIDENT_ACTIVE_DAYS,
  type RunwayThresholds,
} from '@/agent/lib/billing/runway'

const T: RunwayThresholds = { warningDays: 14, actionDays: 7, emergencyDays: 3 }

describe('roundUsdCents', () => {
  it('rounds to whole cents', () => {
    expect(roundUsdCents(2.344)).toBe(2.34)
    expect(roundUsdCents(2.346)).toBe(2.35)
    expect(roundUsdCents(10)).toBe(10)
  })
  it('coerces non-finite to 0', () => {
    expect(roundUsdCents(Number.NaN)).toBe(0)
    expect(roundUsdCents(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('computeDailyBurn', () => {
  it('averages over active days, not calendar days', () => {
    const burn = computeDailyBurn({ totalUsd: 20, activeDays: 4, windowDays: 7 })
    expect(burn.usdPerDay).toBe(5)
    expect(burn.basis).toBe('active_days')
    expect(burn.confident).toBe(true)
  })

  it('flags low confidence below the active-day floor', () => {
    const burn = computeDailyBurn({ totalUsd: 10, activeDays: 1, windowDays: 7 })
    expect(burn.usdPerDay).toBe(10)
    expect(burn.confident).toBe(false)
    expect(burn.activeDays).toBeLessThan(MIN_CONFIDENT_ACTIVE_DAYS)
  })

  it('treats no spend as a 0/day no_spend burn', () => {
    const burn = computeDailyBurn({ totalUsd: 0, activeDays: 0, windowDays: 7 })
    expect(burn.usdPerDay).toBe(0)
    expect(burn.basis).toBe('no_spend')
    expect(burn.confident).toBe(false)
  })

  it('ignores negative/garbage totals and days', () => {
    const burn = computeDailyBurn({ totalUsd: -5, activeDays: -3, windowDays: 7 })
    expect(burn.usdPerDay).toBe(0)
    expect(burn.basis).toBe('no_spend')
  })

  it('floors fractional active days', () => {
    const burn = computeDailyBurn({ totalUsd: 12, activeDays: 3.9, windowDays: 7 })
    // floor(3.9) = 3 active days → 12 / 3 = 4
    expect(burn.usdPerDay).toBe(4)
    expect(burn.confident).toBe(true)
  })
})

describe('classifyRunway', () => {
  it('maps day counts to bands (inclusive lower edges)', () => {
    expect(classifyRunway(3, T)).toBe('emergency')
    expect(classifyRunway(2, T)).toBe('emergency')
    expect(classifyRunway(7, T)).toBe('action')
    expect(classifyRunway(4, T)).toBe('action')
    expect(classifyRunway(14, T)).toBe('warning')
    expect(classifyRunway(8, T)).toBe('warning')
    expect(classifyRunway(15, T)).toBe('ok')
    expect(classifyRunway(120, T)).toBe('ok')
  })

  it('null runway is unknown, never ok', () => {
    expect(classifyRunway(null, T)).toBe('unknown')
  })
})

describe('computeRunway', () => {
  it('floors days so headroom is never rounded up', () => {
    const burn = computeDailyBurn({ totalUsd: 21, activeDays: 3, windowDays: 7 }) // $7/day
    const r = computeRunway(50, burn, T) // 50 / 7 = 7.14 → 7
    expect(r.days).toBe(7)
    expect(r.status).toBe('action')
    expect(r.confident).toBe(true)
  })

  it('null balance (quota / postpaid / no wallet) → unknown', () => {
    const burn = computeDailyBurn({ totalUsd: 21, activeDays: 3, windowDays: 7 })
    const r = computeRunway(null, burn, T)
    expect(r.days).toBeNull()
    expect(r.status).toBe('unknown')
  })

  it('idle burn never yields infinite runway', () => {
    const burn = computeDailyBurn({ totalUsd: 0, activeDays: 0, windowDays: 7 })
    const r = computeRunway(100, burn, T)
    expect(r.days).toBeNull()
    expect(r.status).toBe('unknown')
    expect(Number.isFinite(r.burnUsdPerDay)).toBe(true)
  })

  it('carries the low-confidence flag through from burn', () => {
    const burn = computeDailyBurn({ totalUsd: 10, activeDays: 1, windowDays: 7 }) // $10/day, not confident
    const r = computeRunway(100, burn, T)
    expect(r.days).toBe(10)
    expect(r.confident).toBe(false)
  })

  it('zero balance is emergency, not unknown', () => {
    const burn = computeDailyBurn({ totalUsd: 21, activeDays: 3, windowDays: 7 })
    const r = computeRunway(0, burn, T)
    expect(r.days).toBe(0)
    expect(r.status).toBe('emergency')
  })
})

describe('computeSuggestedTopUp', () => {
  const burn = computeDailyBurn({ totalUsd: 70, activeDays: 7, windowDays: 7 }) // $10/day

  it('suggests the gap to the target runway, rounded up to increment', () => {
    // target 30 days → $300 target balance; balance $50 → need $250; increment $10
    const s = computeSuggestedTopUp(50, burn, { targetDays: 30, incrementUsd: 10 })
    expect(s.none).toBe(false)
    expect(s.amountUsd).toBe(250)
    expect(s.cappedByMonthlyMax).toBe(false)
  })

  it('rounds a non-multiple up to the next increment', () => {
    // need $255 rounded up to $10 increment → $260
    const s = computeSuggestedTopUp(45, burn, { targetDays: 30, incrementUsd: 10 })
    expect(s.amountUsd).toBe(260)
  })

  it('honors a provider minimum', () => {
    // balance already near target; tiny need bumped to the $20 minimum
    const s = computeSuggestedTopUp(295, burn, { targetDays: 30, minimumUsd: 20, incrementUsd: 5 })
    expect(s.amountUsd).toBe(20)
  })

  it('returns none when already past the target', () => {
    const s = computeSuggestedTopUp(400, burn, { targetDays: 30 })
    expect(s.none).toBe(true)
    expect(s.amountUsd).toBe(0)
  })

  it('returns none for unknown balance or idle burn', () => {
    expect(computeSuggestedTopUp(null, burn, { targetDays: 30 }).none).toBe(true)
    const idle = computeDailyBurn({ totalUsd: 0, activeDays: 0, windowDays: 7 })
    expect(computeSuggestedTopUp(50, idle, { targetDays: 30 }).none).toBe(true)
  })

  it('caps the suggestion at the remaining monthly max', () => {
    // raw need $250, but only $100 of monthly cap remains
    const s = computeSuggestedTopUp(50, burn, {
      targetDays: 30,
      incrementUsd: 10,
      monthlyMaxUsd: 150,
      fundedThisMonthUsd: 50,
    })
    expect(s.amountUsd).toBe(100)
    expect(s.cappedByMonthlyMax).toBe(true)
  })

  it('returns none when the monthly cap is already exhausted', () => {
    const s = computeSuggestedTopUp(50, burn, {
      targetDays: 30,
      monthlyMaxUsd: 100,
      fundedThisMonthUsd: 100,
    })
    expect(s.none).toBe(true)
  })
})
