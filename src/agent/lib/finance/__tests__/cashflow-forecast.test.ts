import { describe, it, expect } from 'vitest'
import {
  forecastCashFlow,
  buildCashObligations,
  classifyCashFlowAction,
  type ForecastInput,
} from '@/agent/lib/finance/cashflow-forecast'
import type { AutonomyPolicy } from '@/agent/lib/autonomy-policy'

function policy(overrides: Partial<AutonomyPolicy> = {}): AutonomyPolicy {
  return {
    enabled: true,
    moneyCapTaka: 100000,
    confidenceMin: 0.5,
    categoryModes: {
      cs_reply: 'auto',
      order_confirm: 'auto',
      order_followup: 'auto',
      reorder: 'auto',
      finance: 'auto',
      marketing: 'auto',
      staff_task: 'auto',
      other: 'auto',
    },
    ...overrides,
  }
}

function base(overrides: Partial<ForecastInput> = {}): ForecastInput {
  return {
    openingCashTaka: null,
    dailyInflowTaka: 1000,
    dailyOutflowTaka: 600,
    obligations: [],
    horizonDays: 30,
    safetyFloorTaka: 0,
    ...overrides,
  }
}

describe('forecastCashFlow', () => {
  it('a healthy positive run-rate with no obligations never dips below zero', () => {
    const f = forecastCashFlow(base())
    expect(f.dailyNetTaka).toBe(400)
    expect(f.shortfall).toBe(false)
    expect(f.shortfallDay).toBeNull()
    expect(f.lowestBalanceTaka).toBe(0) // day 0 start, net-flow from 0
    expect(f.endBalanceTaka).toBe(400 * 30)
    expect(f.points).toHaveLength(31) // day 0..30 inclusive
  })

  it('flags a shortfall when a big bill lands before enough cash accrues', () => {
    // +400/day; a 5000 bill due day 5 → by day 5 only 2000 accrued → balance -3000.
    const f = forecastCashFlow(base({ obligations: [{ label: 'rent', amountTaka: 5000, dueInDays: 5 }] }))
    expect(f.shortfall).toBe(true)
    expect(f.shortfallDay).toBe(5)
    expect(f.lowestBalanceTaka).toBe(-3000)
    expect(f.lowestDay).toBe(5)
    expect(f.shortfallGapTaka).toBe(3000) // floor 0 − (−3000)
    expect(f.totalObligationsTaka).toBe(5000)
  })

  it('a negative daily net (burning cash) trips the shortfall on day 1', () => {
    const f = forecastCashFlow(base({ dailyInflowTaka: 300, dailyOutflowTaka: 800 }))
    expect(f.dailyNetTaka).toBe(-500)
    expect(f.shortfall).toBe(true)
    expect(f.shortfallDay).toBe(1)
    expect(f.endBalanceTaka).toBe(-500 * 30)
  })

  it('honours a known opening balance and a non-zero safety floor', () => {
    // Opening 10000, net −500/day, floor 5000. Balance hits 5000 at day 10 (10000-5*... wait)
    // 10000 - 500*day < 5000  → day > 10 → first breach at day 11.
    const f = forecastCashFlow(base({ openingCashTaka: 10000, dailyInflowTaka: 0, dailyOutflowTaka: 500, safetyFloorTaka: 5000 }))
    expect(f.openingKnown).toBe(true)
    expect(f.shortfall).toBe(true)
    expect(f.shortfallDay).toBe(11)
  })

  it('clamps past-due obligations to day 0', () => {
    const f = forecastCashFlow(base({ openingCashTaka: 1000, obligations: [{ label: 'overdue', amountTaka: 1500, dueInDays: -3 }] }))
    expect(f.points[0].balanceTaka).toBe(-500) // 1000 opening − 1500 overdue, hits on day 0
    expect(f.shortfallDay).toBe(0)
  })

  it('ignores zero/negative obligation amounts', () => {
    const f = forecastCashFlow(base({ obligations: [{ label: 'junk', amountTaka: 0, dueInDays: 3 }] }))
    expect(f.totalObligationsTaka).toBe(0)
    expect(f.shortfall).toBe(false)
  })
})

describe('buildCashObligations', () => {
  it('includes in-horizon BDT bills + subscriptions and excludes foreign currency', () => {
    const { obligations, skippedForeign } = buildCashObligations({
      bills: [
        { name: 'বিদ্যুৎ', amount: 3000, currency: 'BDT', daysUntil: 4 },
        { name: 'rent', amount: 20000, currency: 'BDT', daysUntil: 60 }, // beyond horizon 30
      ],
      subscriptions: [
        { name: 'Netflix', amount: 15, currency: 'USD', daysUntil: 10 }, // foreign → skipped
        { name: 'হোস্টিং', amount: 1200, currency: 'BDT', daysUntil: 7 },
      ],
      horizonDays: 30,
    })
    expect(obligations.map((o) => o.label).sort()).toEqual(['বিদ্যুৎ', 'হোস্টিং'])
    expect(obligations.find((o) => o.label === 'বিদ্যুৎ')?.dueInDays).toBe(4)
    expect(skippedForeign).toHaveLength(1)
    expect(skippedForeign[0].currency).toBe('USD')
  })

  it('drops items with null daysUntil or non-positive amount', () => {
    const { obligations } = buildCashObligations({
      bills: [
        { name: 'undated', amount: 500, currency: 'BDT', daysUntil: null },
        { name: 'free', amount: 0, currency: 'BDT', daysUntil: 5 },
      ],
      subscriptions: [],
      horizonDays: 30,
    })
    expect(obligations).toHaveLength(0)
  })
})

describe('classifyCashFlowAction', () => {
  it('produces a shortfall-worded summary and lets policy decide the mode', () => {
    const f = forecastCashFlow(base({ obligations: [{ label: 'rent', amountTaka: 5000, dueInDays: 5 }] }))
    const a = classifyCashFlowAction(f, policy())
    expect(a.summary).toContain('ঘাটতি')
    expect(a.mode).toBe('auto') // finance=auto, reversible alert, confidence 0.65 >= min 0.5
    expect(a.willAuto).toBe(true)
  })

  it('forces ask (never auto) when the master switch is OFF', () => {
    const f = forecastCashFlow(base())
    const a = classifyCashFlowAction(f, policy({ enabled: false }))
    expect(a.mode).toBe('ask')
    expect(a.willAuto).toBe(false)
  })

  it('a low confidence floor downgrades the alert below auto', () => {
    const f = forecastCashFlow(base())
    const a = classifyCashFlowAction(f, policy({ confidenceMin: 0.9 }))
    expect(a.mode).not.toBe('auto')
  })
})
