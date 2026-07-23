import { describe, it, expect } from 'vitest'
import { decideCostGate, costGateMessage } from '../cost-gate'

const base = { killSwitch: false, dailyUsd: null, monthlyUsd: null, todaySpendUsd: 0, monthSpendUsd: 0 }

describe('cost gate pre-authorization (P0-2)', () => {
  it('allows when no switch and no caps configured', () => {
    expect(decideCostGate(base).allow).toBe(true)
  })

  it('kill switch stops every paid call', () => {
    const d = decideCostGate({ ...base, killSwitch: true })
    expect(d.allow).toBe(false)
    expect(d.reason).toBe('kill_switch')
  })

  it('daily budget is a hard deterministic stop at the cap', () => {
    expect(decideCostGate({ ...base, dailyUsd: 5, todaySpendUsd: 4.99 }).allow).toBe(true)
    const d = decideCostGate({ ...base, dailyUsd: 5, todaySpendUsd: 5 })
    expect(d.allow).toBe(false)
    expect(d.reason).toBe('daily_budget')
  })

  it('monthly budget stops after the daily check', () => {
    const d = decideCostGate({ ...base, monthlyUsd: 60, monthSpendUsd: 61 })
    expect(d.allow).toBe(false)
    expect(d.reason).toBe('monthly_budget')
  })

  it('cs surface is exempt from budget stops but NOT from the kill switch', () => {
    expect(decideCostGate({ ...base, dailyUsd: 5, todaySpendUsd: 10 }, 'cs').allow).toBe(true)
    expect(decideCostGate({ ...base, monthlyUsd: 50, monthSpendUsd: 60 }, 'cs').allow).toBe(true)
    const d = decideCostGate({ ...base, killSwitch: true }, 'cs')
    expect(d.allow).toBe(false)
    expect(d.reason).toBe('kill_switch')
  })

  it('a zero/negative cap means "not configured", never block-everything', () => {
    expect(decideCostGate({ ...base, dailyUsd: 0, todaySpendUsd: 100 }).allow).toBe(true)
    expect(decideCostGate({ ...base, monthlyUsd: -1, monthSpendUsd: 100 }).allow).toBe(true)
  })

  it('blocked decisions carry an owner-facing Bangla message (no Sir)', () => {
    for (const d of [
      decideCostGate({ ...base, killSwitch: true }),
      decideCostGate({ ...base, dailyUsd: 5, todaySpendUsd: 6 }),
      decideCostGate({ ...base, monthlyUsd: 50, monthSpendUsd: 50 }),
    ]) {
      const msg = costGateMessage(d)
      expect(msg).toContain('Boss')
      expect(msg).not.toMatch(/স্যার|Sir/)
    }
  })
})
