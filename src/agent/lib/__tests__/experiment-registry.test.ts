import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockPrisma = vi.hoisted(() => ({
  agentGrowthExperiment: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  },
}))
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

beforeEach(() => vi.clearAllMocks())

import {
  validateHypothesis,
  evaluateExperiment,
  createExperiment,
  concludeExperiment,
  startExperiment,
  type ExperimentHypothesis,
} from '@/agent/lib/marketing/experiment-registry'
import { assessCalendarHealth, findCalendarConflicts } from '@/agent/lib/marketing/content-calendar'
import { validateCroBrief } from '@/agent/lib/marketing/cro-brief'

const hypothesis = (over: Partial<ExperimentHypothesis> = {}): ExperimentHypothesis => ({
  audience: 'young parents Dhaka',
  awarenessStage: 'problem_aware',
  painOrDesire: 'Eid outfit matching family',
  offer: 'father-son panjabi set ৳1990',
  angle: 'family bonding',
  hook: 'বাবা-ছেলের ম্যাচিং সেট',
  proof: 'real customer photos (consented)',
  format: 'reel',
  destination: 'messenger',
  metric: 'cost_per_confirmed_order_bdt',
  guardrailMetric: 'delivered_rate_pct',
  minSample: 20,
  windowDays: 14,
  winnerRule: { direction: 'lte', value: 250 },
  guardrailRule: { direction: 'gte', value: 60 },
  ...over,
})

describe('validateHypothesis', () => {
  it('complete hypothesis passes', () => {
    expect(validateHypothesis(hypothesis())).toEqual({ ok: true, missing: [] })
  })

  it('missing pieces are each named', () => {
    const v = validateHypothesis({ audience: 'x' })
    expect(v.ok).toBe(false)
    for (const key of ['painOrDesire', 'offer', 'angle', 'hook', 'proof', 'destination', 'metric', 'guardrailMetric', 'minSample (≥1)', 'windowDays (≥1)', 'winnerRule', 'guardrailRule']) {
      expect(v.missing).toContain(key)
    }
  })
})

describe('evaluateExperiment — pre-agreed rules, no early winner', () => {
  it('below sample floor → inconclusive, not judgeable, even with a great metric', () => {
    const e = evaluateExperiment(hypothesis(), { sample: 5, metricValue: 100, guardrailValue: 80 })
    expect(e.verdict).toBe('inconclusive')
    expect(e.judgeable).toBe(false)
    expect(e.reason).toContain('5/20')
  })

  it('guardrail breach beats everything — even below sample floor', () => {
    const e = evaluateExperiment(hypothesis(), { sample: 5, metricValue: 100, guardrailValue: 30 })
    expect(e.verdict).toBe('guardrail_breach')
  })

  it('winner rule lte: metric at/below threshold wins at sample', () => {
    expect(evaluateExperiment(hypothesis(), { sample: 25, metricValue: 240, guardrailValue: 70 }).verdict).toBe('won')
    expect(evaluateExperiment(hypothesis(), { sample: 25, metricValue: 260, guardrailValue: 70 }).verdict).toBe('lost')
  })

  it('winner rule gte works for maximize metrics', () => {
    const h = hypothesis({ metric: 'roas', winnerRule: { direction: 'gte', value: 3 } })
    expect(evaluateExperiment(h, { sample: 25, metricValue: 3.4, guardrailValue: 70 }).verdict).toBe('won')
  })
})

describe('experiment lifecycle', () => {
  it('createExperiment refuses an incomplete hypothesis', async () => {
    await expect(createExperiment({ name: 'bad', hypothesis: { audience: 'x' } as ExperimentHypothesis })).rejects.toThrow(/incomplete/)
    expect(mockPrisma.agentGrowthExperiment.create).not.toHaveBeenCalled()
  })

  it('concludeExperiment demands a real learning sentence', async () => {
    await expect(concludeExperiment({ id: 'e1', verdict: 'won', learning: '' })).rejects.toThrow(/learning/)
    await expect(concludeExperiment({ id: 'e1', verdict: 'won', learning: 'ok' })).rejects.toThrow(/learning/)
  })

  it('conclude stores outcome + learning; guardrail_breach maps to lost', async () => {
    mockPrisma.agentGrowthExperiment.findUnique.mockResolvedValue({ id: 'e1', status: 'running' })
    mockPrisma.agentGrowthExperiment.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'e1', ...data }))
    const row = await concludeExperiment({
      id: 'e1', verdict: 'guardrail_breach',
      observed: { sample: 30, metricValue: 200, guardrailValue: 20 },
      learning: 'cheap orders that never deliver are not growth',
    })
    expect(row.status).toBe('lost')
    expect(mockPrisma.agentGrowthExperiment.update.mock.calls[0][0].data.learning).toContain('deliver')
  })

  it('startExperiment is idempotent for running experiments', async () => {
    mockPrisma.agentGrowthExperiment.findUnique.mockResolvedValue({ id: 'e2', status: 'running' })
    const row = await startExperiment('e2')
    expect(row.status).toBe('running')
    expect(mockPrisma.agentGrowthExperiment.update).not.toHaveBeenCalled()
  })
})

describe('calendar health (pure)', () => {
  const now = new Date('2026-07-17T12:00:00+06:00')
  const mk = (id: string, minsFromNow: number, status: string, platform = 'facebook', pageRef = 'lifestyle') => ({
    id, platform, pageRef, status, scheduledFor: new Date(now.getTime() + minsFromNow * 60000), error: status === 'failed' ? 'token expired' : null,
  })

  it('flags same-page posts closer than the window; different pages fine', () => {
    const conflicts = findCalendarConflicts([mk('a', 60, 'approved'), mk('b', 100, 'draft'), mk('c', 70, 'approved', 'facebook', 'onlineshop')])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ a: 'a', b: 'b' })
  })

  it('counts stale drafts, stuck approved, failures with advice', () => {
    const h = assessCalendarHealth(
      [mk('old-draft', -120, 'draft'), mk('stuck', -60, 'approved'), mk('bad', -30, 'failed'), mk('ok', 240, 'approved')],
      now,
    )
    expect(h.staleDrafts).toBe(1)
    expect(h.pastDueApproved).toBe(1)
    expect(h.failed).toHaveLength(1)
    expect(h.failed[0].error).toBe('token expired')
    expect(h.advice.length).toBeGreaterThanOrEqual(3)
  })
})

describe('CRO brief validation', () => {
  it('evidence and rollback are non-negotiable', () => {
    const v = validateCroBrief({
      page: '/checkout', problem: 'drop-off', hypothesis: 'form too long', change: 'reduce fields',
      expectedImpact: { metric: 'checkout_completion', lowPct: 5, highPct: 15 },
      checklist: { accessibility: true, mobile: true, performance: true },
    })
    expect(v.ok).toBe(false)
    expect(v.errors.join()).toContain('evidence')
    expect(v.errors.join()).toContain('rollback')
  })

  it('complete brief with impact range passes; inverted range fails', () => {
    const brief = {
      page: '/checkout', problem: 'drop-off at address step',
      evidence: [{ source: 'GA4', metric: 'funnel_step_dropoff_pct', value: 62 }],
      hypothesis: 'address form friction', change: 'collapse to 3 fields + auto area suggest',
      expectedImpact: { metric: 'checkout_completion', lowPct: 5, highPct: 15 },
      checklist: { accessibility: true, mobile: true, performance: true },
      rollbackPlan: 'feature-flag revert within 5 minutes',
    }
    expect(validateCroBrief(brief).ok).toBe(true)
    expect(validateCroBrief({ ...brief, expectedImpact: { metric: 'x', lowPct: 20, highPct: 10 } }).ok).toBe(false)
  })
})
