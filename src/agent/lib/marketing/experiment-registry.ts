/**
 * Phase 44 — the experiment registry: marketing as testable hypotheses,
 * not volume spam.
 *
 * Every asset/campaign/CRO change belongs to ONE experiment with an explicit
 * hypothesis (audience, awareness stage, pain/desire, offer, angle, hook,
 * proof, format, destination), a primary metric + guardrail, a minimum sample
 * and time window, and pre-agreed winner/loser rules. Evaluation refuses to
 * call a winner before the sample floor — no early knee-jerk calls.
 */
import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export interface ExperimentHypothesis {
  audience: string
  awarenessStage: 'unaware' | 'problem_aware' | 'solution_aware' | 'product_aware' | 'most_aware'
  painOrDesire: string
  offer: string
  angle: string
  hook: string
  /** Evidence backing the promise (real testimonial ref, product fact, guarantee actually honored). */
  proof: string
  format: 'static' | 'carousel' | 'reel' | 'story' | 'messenger' | 'landing_page' | 'email' | 'sms' | 'organic_post'
  destination: string
  /** Primary decision metric, e.g. "cost_per_confirmed_order_bdt". */
  metric: string
  /** Guardrail that must not regress, e.g. "delivered_rate_pct". */
  guardrailMetric: string
  /** Below this observation count the experiment is not judgeable. */
  minSample: number
  windowDays: number
  /** e.g. { direction: 'lte', value: 250 } → metric ≤ 250 wins. */
  winnerRule: { direction: 'lte' | 'gte'; value: number }
  /** Guardrail floor/ceiling; breach = stop as lost regardless of metric. */
  guardrailRule: { direction: 'lte' | 'gte'; value: number }
}

export interface HypothesisValidation {
  ok: boolean
  missing: string[]
}

const REQUIRED_TEXT: Array<keyof ExperimentHypothesis> = [
  'audience', 'painOrDesire', 'offer', 'angle', 'hook', 'proof', 'destination', 'metric', 'guardrailMetric',
]

/** Structural completeness gate — an experiment without these is just posting. */
export function validateHypothesis(h: Partial<ExperimentHypothesis> | null | undefined): HypothesisValidation {
  const missing: string[] = []
  if (!h) return { ok: false, missing: ['hypothesis'] }
  for (const key of REQUIRED_TEXT) {
    if (!String(h[key] ?? '').trim()) missing.push(key)
  }
  if (!h.awarenessStage) missing.push('awarenessStage')
  if (!h.format) missing.push('format')
  if (!h.minSample || h.minSample < 1) missing.push('minSample (≥1)')
  if (!h.windowDays || h.windowDays < 1) missing.push('windowDays (≥1)')
  if (!h.winnerRule || !Number.isFinite(h.winnerRule.value)) missing.push('winnerRule')
  if (!h.guardrailRule || !Number.isFinite(h.guardrailRule.value)) missing.push('guardrailRule')
  return { ok: missing.length === 0, missing }
}

export type ExperimentVerdict = 'won' | 'lost' | 'inconclusive' | 'guardrail_breach'

export interface ExperimentEvaluation {
  verdict: ExperimentVerdict
  judgeable: boolean
  reason: string
}

/**
 * Judge an experiment from observed numbers against its pre-agreed rules.
 * Pure. Sample floor is enforced BEFORE any winner call.
 */
export function evaluateExperiment(
  h: ExperimentHypothesis,
  observed: { sample: number; metricValue: number; guardrailValue: number },
): ExperimentEvaluation {
  const guardOk =
    h.guardrailRule.direction === 'lte'
      ? observed.guardrailValue <= h.guardrailRule.value
      : observed.guardrailValue >= h.guardrailRule.value
  if (!guardOk) {
    return {
      verdict: 'guardrail_breach',
      judgeable: true,
      reason: `guardrail ${h.guardrailMetric}=${observed.guardrailValue} breached rule ${h.guardrailRule.direction} ${h.guardrailRule.value} — stop regardless of the primary metric`,
    }
  }
  if (observed.sample < h.minSample) {
    return {
      verdict: 'inconclusive',
      judgeable: false,
      reason: `sample ${observed.sample}/${h.minSample} — below the pre-agreed floor, no winner call allowed yet`,
    }
  }
  const win =
    h.winnerRule.direction === 'lte' ? observed.metricValue <= h.winnerRule.value : observed.metricValue >= h.winnerRule.value
  return win
    ? { verdict: 'won', judgeable: true, reason: `${h.metric}=${observed.metricValue} meets ${h.winnerRule.direction} ${h.winnerRule.value} at sample ${observed.sample}` }
    : { verdict: 'lost', judgeable: true, reason: `${h.metric}=${observed.metricValue} fails ${h.winnerRule.direction} ${h.winnerRule.value} at sample ${observed.sample}` }
}

export interface ExperimentRow {
  id: string
  businessId: string
  name: string
  status: string
  hypothesis: ExperimentHypothesis
  briefVersion: number | null
  startAt: Date | null
  endAt: Date | null
  outcome: unknown
  learning: string | null
}

/** Register a draft experiment. Incomplete hypotheses are refused. */
export async function createExperiment(opts: {
  businessId?: string
  name: string
  hypothesis: ExperimentHypothesis
  briefVersion?: number | null
}): Promise<ExperimentRow> {
  const v = validateHypothesis(opts.hypothesis)
  if (!v.ok) throw new Error(`hypothesis incomplete — missing: ${v.missing.join(', ')}`)
  return db.agentGrowthExperiment.create({
    data: {
      businessId: opts.businessId ?? 'ALMA_LIFESTYLE',
      name: opts.name.trim(),
      status: 'draft',
      hypothesis: opts.hypothesis,
      briefVersion: opts.briefVersion ?? null,
    },
  })
}

export async function listExperiments(opts?: { businessId?: string; status?: string; limit?: number }): Promise<ExperimentRow[]> {
  return db.agentGrowthExperiment.findMany({
    where: {
      businessId: opts?.businessId ?? 'ALMA_LIFESTYLE',
      ...(opts?.status ? { status: opts.status } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: opts?.limit ?? 25,
  })
}

/** Start a draft/approved experiment (stamps the clock for the window). */
export async function startExperiment(id: string): Promise<ExperimentRow> {
  const row = await db.agentGrowthExperiment.findUnique({ where: { id } })
  if (!row) throw new Error(`experiment ${id} not found`)
  if (row.status === 'running') return row
  if (row.status !== 'draft' && row.status !== 'approved') throw new Error(`experiment ${id} is ${row.status}`)
  return db.agentGrowthExperiment.update({ where: { id }, data: { status: 'running', startAt: new Date() } })
}

/**
 * Conclude an experiment. A learning sentence is MANDATORY — an experiment
 * that teaches nothing recorded is a wasted experiment.
 */
export async function concludeExperiment(opts: {
  id: string
  verdict: ExperimentVerdict | 'stopped'
  observed?: { sample: number; metricValue: number; guardrailValue: number }
  learning: string
}): Promise<ExperimentRow> {
  if (!opts.learning?.trim() || opts.learning.trim().length < 10) {
    throw new Error('learning is required (≥10 chars): what did this experiment teach us?')
  }
  const row = await db.agentGrowthExperiment.findUnique({ where: { id: opts.id } })
  if (!row) throw new Error(`experiment ${opts.id} not found`)
  const status = opts.verdict === 'guardrail_breach' ? 'lost' : opts.verdict
  return db.agentGrowthExperiment.update({
    where: { id: opts.id },
    data: {
      status,
      endAt: new Date(),
      outcome: opts.observed ? { ...opts.observed, verdict: opts.verdict } : { verdict: opts.verdict },
      learning: opts.learning.trim(),
    },
  })
}

/** Verified learnings, newest first — the evidence store future decisions read. */
export async function listLearnings(businessId = 'ALMA_LIFESTYLE', limit = 20): Promise<Array<{ name: string; status: string; learning: string; endAt: Date | null }>> {
  const rows = await db.agentGrowthExperiment.findMany({
    where: { businessId, learning: { not: null }, status: { in: ['won', 'lost', 'inconclusive', 'stopped'] } },
    orderBy: { endAt: 'desc' },
    take: limit,
    select: { name: true, status: true, learning: true, endAt: true },
  })
  return rows
}
