import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/prisma', () => ({ prisma: {} }))

import {
  assembleProposal,
  identifyMissingData,
  loadBusinessTruth,
  prioritizeBottleneck,
  type StrategyInputs,
} from '@/agent/lib/marketing/growth-strategy-graph'
import type { MeasurementHealth } from '@/agent/lib/marketing/measurement-health'
import type { GrowthBriefContent } from '@/agent/lib/marketing/growth-brief'

const measurement = (over: Partial<MeasurementHealth> = {}): MeasurementHealth => ({
  generatedAt: '2026-07-17T00:00:00Z',
  windowDays: 7,
  erp: { observed: true, orders: 20, delivered: 14, revenueBdt: 40000 },
  analytics: { ga4Configured: true, observed: true, sessions: 900, keyEvents: 40 },
  paid: { observed: true, spendBdt: 8000, currency: 'BDT', accountId: 'act_test', campaignsWithData: 2 },
  gaps: [],
  thinData: false,
  ...over,
})

const inputs = (over: Partial<StrategyInputs> = {}): StrategyInputs => ({
  measurement: measurement(),
  capabilities: { summary: { total: 10, proven: 8, broken: 0, unknown: 2, unsupported: 0 }, checks: [] },
  draftBrief: completeBrief(),
  ...over,
})

function completeBrief(): GrowthBriefContent {
  return {
    goals: [{ kind: 'decision', text: 'grow delivered orders' }],
    products: { focus: [{ name: 'Panjabi', availability: 'in_stock', marginPctOfPrice: 35 }] },
    economics: { monthlyBudgetCapBdt: 30000 },
    customers: { segments: [{ name: 'young parents' }] },
    objective: 'confirmed COD orders',
    measurementPlan: 'weekly funnel',
  }
}

describe('loadBusinessTruth — facts only, tagged', () => {
  it('emits only observed sources, every statement kind=fact', () => {
    const facts = loadBusinessTruth(inputs({ measurement: measurement({ analytics: { ga4Configured: false, observed: false, sessions: null, keyEvents: null } }) }))
    expect(facts.length).toBeGreaterThan(0)
    expect(facts.every((f) => f.kind === 'fact')).toBe(true)
    expect(facts.some((f) => f.text.includes('GA4'))).toBe(false)
  })

  it('broken capabilities surface as facts', () => {
    const facts = loadBusinessTruth(
      inputs({
        capabilities: {
          summary: { total: 1, proven: 0, broken: 1, unknown: 0, unsupported: 0 },
          checks: [{ key: 'ga4', area: 'google', label: 'GA4', status: 'broken', scope: 'p', evidence: 'e' }],
        },
      }),
    )
    expect(facts.some((f) => f.text.includes('Broken capabilities'))).toBe(true)
  })
})

describe('identifyMissingData', () => {
  it('joins high-severity measurement gaps + brief gaps', () => {
    const m = measurement({
      gaps: [
        { kind: 'missing_analytics', severity: 'high', detail: 'no GA4' },
        { kind: 'thin_sample', severity: 'medium', detail: 'thin' },
      ],
    })
    const missing = identifyMissingData(inputs({ measurement: m, draftBrief: null }))
    expect(missing).toContain('no GA4')
    expect(missing).not.toContain('thin')
    expect(missing.some((x) => x.startsWith('brief:'))).toBe(true)
  })
})

describe('prioritizeBottleneck — deterministic funnel diagnosis', () => {
  it('unreadable ERP → measurement first', () => {
    const b = prioritizeBottleneck(inputs({ measurement: measurement({ erp: { observed: false, orders: 0, delivered: null, revenueBdt: 0 } }) }))
    expect(b.stage).toBe('measurement')
    expect(b.severity).toBe('high')
  })

  it('high funnel break → delivery', () => {
    const m = measurement({ gaps: [{ kind: 'funnel_break', severity: 'high', detail: 'x' }] })
    expect(prioritizeBottleneck(inputs({ measurement: m })).stage).toBe('delivery')
  })

  it('spend with zero orders → conversion', () => {
    const m = measurement({ erp: { observed: true, orders: 0, delivered: 0, revenueBdt: 0 }, paid: { observed: true, spendBdt: 5000, currency: 'BDT', accountId: 'act_test', campaignsWithData: 1 } })
    expect(prioritizeBottleneck(inputs({ measurement: m })).stage).toBe('conversion')
  })

  it('thin data → demand', () => {
    expect(prioritizeBottleneck(inputs({ measurement: measurement({ thinData: true }) })).stage).toBe('demand')
  })

  it('delivered rate < 50% → delivery leak outranks scale', () => {
    const m = measurement({ erp: { observed: true, orders: 20, delivered: 5, revenueBdt: 10000 } })
    expect(prioritizeBottleneck(inputs({ measurement: m })).stage).toBe('delivery')
  })

  it('healthy funnel → scale', () => {
    expect(prioritizeBottleneck(inputs()).stage).toBe('scale')
  })
})

describe('assembleProposal — evidence-backed, never generic', () => {
  it('produces ≥2 options, each with assumptions and RANGE forecasts', () => {
    const p = assembleProposal(inputs())
    expect(p.options.length).toBeGreaterThanOrEqual(2)
    for (const o of p.options) {
      expect(o.assumptions.length).toBeGreaterThan(0)
      for (const f of o.forecast) {
        expect(f.low).toBeLessThanOrEqual(f.high)
        expect(f.window).toBeTruthy()
      }
    }
    expect(p.recommendedOption).toBeLessThan(p.options.length)
    expect(p.planSkeleton.map((s) => s.horizon)).toEqual(['90d', 'month', 'week'])
  })

  it('ten distinct scenarios produce targeted (non-identical) priorities', () => {
    const scenarios: StrategyInputs[] = [
      inputs({ measurement: measurement({ erp: { observed: false, orders: 0, delivered: null, revenueBdt: 0 } }) }),
      inputs({ measurement: measurement({ gaps: [{ kind: 'funnel_break', severity: 'high', detail: 'x' }] }) }),
      inputs({ measurement: measurement({ erp: { observed: true, orders: 0, delivered: 0, revenueBdt: 0 } }) }),
      inputs({ measurement: measurement({ thinData: true }) }),
      inputs({ measurement: measurement({ erp: { observed: true, orders: 30, delivered: 6, revenueBdt: 60000 } }) }),
      inputs(),
      inputs({ measurement: measurement({ paid: { observed: true, spendBdt: 0, currency: 'BDT', accountId: 'act_test', campaignsWithData: 0 }, thinData: true }) }),
      inputs({ measurement: measurement({ erp: { observed: true, orders: 100, delivered: 90, revenueBdt: 200000 } }) }),
      inputs({ measurement: measurement({ erp: { observed: true, orders: 8, delivered: 2, revenueBdt: 12000 } }) }),
      inputs({ measurement: measurement({ erp: { observed: false, orders: 0, delivered: null, revenueBdt: 0 }, paid: { observed: false, spendBdt: 0, currency: 'BDT', accountId: 'act_test', campaignsWithData: 0 } }) }),
    ]
    const proposals = scenarios.map((s) => assembleProposal(s))
    const stages = new Set(proposals.map((p) => p.bottleneck.stage))
    // Evidence-backed prioritization: different data → different bottleneck, not one generic answer.
    expect(stages.size).toBeGreaterThanOrEqual(4)
    // And none of them is a contentless "post more" recommendation.
    for (const p of proposals) {
      expect(p.options[p.recommendedOption].rationale.length).toBeGreaterThan(0)
      expect(p.bottleneck.why.length).toBeGreaterThan(10)
    }
  })

  it('separates facts, inference, recommendation kinds in the proposal', () => {
    const p = assembleProposal(inputs())
    expect(p.businessTruth.every((s) => s.kind === 'fact')).toBe(true)
    const kinds = p.options.flatMap((o) => o.rationale.map((r) => r.kind))
    expect(kinds.some((k) => k === 'inference' || k === 'recommendation')).toBe(true)
  })
})
