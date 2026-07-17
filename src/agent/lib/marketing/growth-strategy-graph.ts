/**
 * Phase 42 — durable growth strategy flow (LangGraph).
 *
 *   load business truth → identify missing critical data → diagnose/prioritize
 *   bottleneck → propose strategy options (assumptions + forecast RANGES) →
 *   owner decision → freeze approved brief
 *
 * Design points:
 * - Deterministic core: every node is a pure-ish function over injected data
 *   sources, so the whole flow is unit-testable without network/LLM. The head
 *   narrates the proposal to the owner separately; this graph is the spine.
 * - Facts, inference, recommendation, and owner decision stay separate
 *   (EvidencedStatement.kind) — no invented numbers, forecasts are ranges
 *   with explicit assumptions.
 * - Durable thread `growth:<businessId>` mirrors each run when the shared
 *   LangGraph gate/checkpointer is on (fail-open, same as plan-run-graph).
 * - The owner decision does NOT happen inside the graph: the proposal is
 *   returned, the owner approves via approveBrief(), and recordOwnerDecision
 *   stamps the decision onto the same thread.
 */
import { StateGraph, Annotation, START, END } from '@langchain/langgraph'
import { getGraphCheckpointer, checkpointConfigFor } from '@/agent/lib/graph/graph-checkpointer'
import { isWorkflowGraphEnabled } from '@/agent/lib/graph/seo-batch-graph'
import type { CapabilityMatrix } from '@/agent/lib/marketing/capability-audit'
import type { MeasurementHealth } from '@/agent/lib/marketing/measurement-health'
import {
  validateBriefForPlanning,
  type EvidencedStatement,
  type GrowthBriefContent,
} from '@/agent/lib/marketing/growth-brief'

export const GROWTH_STRATEGY_NS = 'growth_strategy'

export interface StrategyOption {
  title: string
  rationale: EvidencedStatement[]
  /** What must be true for the forecast to hold. */
  assumptions: string[]
  /** Honest range, never a point estimate. Whole-taka where money. */
  forecast: { metric: string; low: number; high: number; window: string }[]
  risks: string[]
  effort: 'low' | 'medium' | 'high'
}

export interface StrategyProposal {
  businessTruth: EvidencedStatement[]
  missingData: string[]
  bottleneck: { stage: string; why: string; severity: 'high' | 'medium' | 'low' }
  options: StrategyOption[]
  recommendedOption: number
  /** 90-day / monthly / weekly skeleton derived from the recommended option. */
  planSkeleton: { horizon: '90d' | 'month' | 'week'; items: string[] }[]
}

export interface StrategyInputs {
  measurement: MeasurementHealth
  capabilities: Pick<CapabilityMatrix, 'summary' | 'checks'>
  draftBrief: GrowthBriefContent | null
}

/** Node 1 — business truth as tagged facts (only what was actually observed). */
export function loadBusinessTruth(inputs: StrategyInputs): EvidencedStatement[] {
  const facts: EvidencedStatement[] = []
  const m = inputs.measurement
  if (m.erp.observed) {
    facts.push({
      kind: 'fact',
      text: `${m.windowDays} দিনে ${m.erp.orders} orders, delivered=${m.erp.delivered ?? 'unknown'}, revenue ৳${m.erp.revenueBdt}`,
      source: 'ERP orders summary',
      observedAt: m.generatedAt,
    })
  }
  if (m.paid.observed) {
    facts.push({
      kind: 'fact',
      text: `Meta spend ${m.paid.spendLabel}, campaigns with decision-grade data: ${m.paid.campaignsWithData}`,
      source: 'Meta insights',
      observedAt: m.generatedAt,
    })
  }
  if (m.analytics.observed) {
    facts.push({
      kind: 'fact',
      text: `GA4: ${m.analytics.sessions ?? 0} sessions, ${m.analytics.keyEvents ?? 0} key events`,
      source: 'GA4 runReport',
      observedAt: m.generatedAt,
    })
  }
  const broken = inputs.capabilities.checks.filter((c) => c.status === 'broken')
  if (broken.length > 0) {
    facts.push({
      kind: 'fact',
      text: `Broken capabilities: ${broken.map((c) => c.label).join(', ')}`,
      source: 'capability audit',
    })
  }
  return facts
}

/** Node 2 — what critical data is missing before strategy can be trusted. */
export function identifyMissingData(inputs: StrategyInputs): string[] {
  const missing: string[] = []
  for (const gap of inputs.measurement.gaps) {
    if (gap.severity === 'high') missing.push(gap.detail)
  }
  const briefGaps = validateBriefForPlanning(inputs.draftBrief)
  if (!briefGaps.ok) missing.push(...briefGaps.missing.map((m) => `brief: ${m}`))
  return missing
}

/** Node 3 — pick the funnel bottleneck from observed numbers (deterministic heuristic). */
export function prioritizeBottleneck(inputs: StrategyInputs): StrategyProposal['bottleneck'] {
  const m = inputs.measurement
  if (!m.erp.observed) {
    return { stage: 'measurement', why: 'ERP funnel is not readable — fix measurement before spending on growth.', severity: 'high' }
  }
  if (m.gaps.some((g) => g.kind === 'funnel_break' && g.severity === 'high')) {
    return { stage: 'delivery', why: 'Orders exist but none delivered — the COD leg (or its reporting) is broken.', severity: 'high' }
  }
  if (m.paid.spend > 0 && m.erp.orders === 0) {
    return { stage: 'conversion', why: 'Spend is flowing with zero orders — creative/offer/landing mismatch.', severity: 'high' }
  }
  if (m.thinData) {
    return { stage: 'demand', why: 'Order volume is decision-thin — grow qualified traffic/leads before optimizing downstream.', severity: 'medium' }
  }
  if ((m.erp.delivered ?? 0) > 0 && m.erp.orders > 0 && (m.erp.delivered ?? 0) / m.erp.orders < 0.5) {
    return { stage: 'delivery', why: 'Less than half of orders deliver — confirmation/delivery leak outranks new traffic.', severity: 'medium' }
  }
  return { stage: 'scale', why: 'Funnel is healthy at current volume — the constraint is reach/budget.', severity: 'low' }
}

/** Node 4 — strategy options per bottleneck (assumption-tagged, range forecasts). */
export function proposeOptions(
  bottleneck: StrategyProposal['bottleneck'],
  inputs: StrategyInputs,
): { options: StrategyOption[]; recommendedOption: number } {
  const cap = inputs.draftBrief?.economics?.monthlyBudgetCapBdt ?? null
  const orders = inputs.measurement.erp.orders
  const windowDays = inputs.measurement.windowDays

  const mk = (o: StrategyOption) => o
  const options: StrategyOption[] = []

  switch (bottleneck.stage) {
    case 'measurement':
      options.push(
        mk({
          title: 'Measurement first — Pixel/CAPI + funnel reconciliation (Phase 43 scope)',
          rationale: [{ kind: 'inference', text: 'Decisions on invisible data burn budget; every later phase depends on event truth.' }],
          assumptions: ['GA4 + Meta assets reachable', 'website events instrumentable'],
          forecast: [{ metric: 'decision-grade funnel coverage', low: 70, high: 95, window: '4 weeks' }],
          risks: ['delays visible growth work by 1–2 weeks'],
          effort: 'medium',
        }),
        mk({
          title: 'Minimal manual tracking while instrumenting',
          rationale: [{ kind: 'recommendation', text: 'Keep spend minimal, log outcomes manually, avoid scaling blind.' }],
          assumptions: ['owner accepts slower pace'],
          forecast: [{ metric: 'wasted-spend risk', low: 0, high: 20, window: 'interim' }],
          risks: ['manual logs drift'],
          effort: 'low',
        }),
      )
      return { options, recommendedOption: 0 }
    case 'delivery':
      options.push(
        mk({
          title: 'Fix confirmation→delivery leak before any new spend',
          rationale: [
            { kind: 'inference', text: 'Each recovered delivery is pure margin vs paying again for a new customer.' },
          ],
          assumptions: ['leak is operational (call latency, courier), not demand quality'],
          forecast: [{ metric: 'delivered rate uplift (pp)', low: 5, high: 20, window: '2–4 weeks' }],
          risks: ['may be a reporting artifact — verify first'],
          effort: 'medium',
        }),
        mk({
          title: 'Parallel: retarget confirmed-but-undelivered customers',
          rationale: [{ kind: 'recommendation', text: 'Messenger follow-up flows on existing intents.' }],
          assumptions: ['messenger reachable', 'Bangla gate passes'],
          forecast: [{ metric: 'recovered orders/week', low: 1, high: Math.max(2, Math.round(orders * 0.1)), window: 'weekly' }],
          risks: ['message fatigue'],
          effort: 'low',
        }),
      )
      return { options, recommendedOption: 0 }
    case 'conversion':
      options.push(
        mk({
          title: 'Offer/creative/landing test matrix (no budget increase)',
          rationale: [{ kind: 'inference', text: 'Spend without orders means message-market mismatch — test angles before scale.' }],
          assumptions: ['at least 2 focus products in stock', 'creative pipeline available'],
          forecast: [{ metric: 'CPA improvement %', low: 10, high: 40, window: '2–3 weeks' }],
          risks: ['small samples need patience — no daily knee-jerk edits'],
          effort: 'medium',
        }),
        mk({
          title: 'Pause paid, push organic + Messenger while diagnosing',
          rationale: [{ kind: 'recommendation', text: 'Stop the bleed if spend efficiency is unproven.' }],
          assumptions: ['organic reach nonzero'],
          forecast: [{ metric: `spend saved (${inputs.measurement.paid.currency}/week)`, low: 0, high: Math.max(0, inputs.measurement.paid.spend), window: 'weekly' }],
          risks: ['loses learning-phase momentum'],
          effort: 'low',
        }),
      )
      return { options, recommendedOption: 0 }
    case 'demand':
      options.push(
        mk({
          title: 'Qualified-demand build: focus products + proven angles, tight budget',
          rationale: [
            { kind: 'inference', text: `${orders} orders in ${windowDays} days cannot support optimization — volume first, inside the approved cap${cap ? ` (৳${cap}/month)` : ''}.` },
          ],
          assumptions: ['stock covers demand', 'budget cap approved'],
          forecast: [{ metric: 'orders/week', low: Math.max(3, orders), high: Math.max(6, orders * 3), window: '4 weeks' }],
          risks: ['thin data means wide variance — ranges, not promises'],
          effort: 'medium',
        }),
        mk({
          title: 'Organic-first: content calendar + community before paid',
          rationale: [{ kind: 'recommendation', text: 'Cheaper demand while measurement matures.' }],
          assumptions: ['content capacity exists'],
          forecast: [{ metric: 'reach growth %', low: 10, high: 50, window: 'monthly' }],
          risks: ['slower than paid'],
          effort: 'low',
        }),
      )
      return { options, recommendedOption: 0 }
    default:
      options.push(
        mk({
          title: 'Controlled scale: +20–30% budget on winners, weekly review',
          rationale: [{ kind: 'inference', text: 'Healthy funnel at current volume — the constraint is reach.' }],
          assumptions: ['delivered-order profit stays positive at higher frequency', 'stock depth'],
          forecast: [{ metric: 'orders/week growth %', low: 10, high: 35, window: '4 weeks' }],
          risks: ['fatigue, learning-phase resets on big jumps'],
          effort: 'low',
        }),
        mk({
          title: 'Hold scale, add repeat/referral loop',
          rationale: [{ kind: 'recommendation', text: 'LTV lever before CAC lever.' }],
          assumptions: ['customer list reachable'],
          forecast: [{ metric: 'repeat rate uplift (pp)', low: 2, high: 10, window: 'quarterly' }],
          risks: ['slower top-line'],
          effort: 'medium',
        }),
      )
      return { options, recommendedOption: 0 }
  }
}

/** Node 5 — 90-day / monthly / weekly plan skeleton from the recommended option. */
export function buildPlanSkeleton(option: StrategyOption, bottleneck: StrategyProposal['bottleneck']): StrategyProposal['planSkeleton'] {
  return [
    {
      horizon: '90d',
      items: [
        `Resolve bottleneck: ${bottleneck.stage} — ${option.title}`,
        'Graduate to next bottleneck once exit metric hits the forecast low bound',
        'Quarterly review: economics vs target, brief revision with changeReason',
      ],
    },
    {
      horizon: 'month',
      items: [
        `Execute "${option.title}" with weekly checkpoints`,
        `Validate assumptions: ${option.assumptions.join('; ')}`,
        'Monthly report: forecast range vs actual, kill/scale decision',
      ],
    },
    {
      horizon: 'week',
      items: [
        'Weekly funnel report (marketing_report) against brief targets',
        `Watch risks: ${option.risks.join('; ')}`,
        'Log outcomes to the experiment/learning store',
      ],
    },
  ]
}

/** Assemble the full proposal deterministically (used by the graph node and directly by tests). */
export function assembleProposal(inputs: StrategyInputs): StrategyProposal {
  const businessTruth = loadBusinessTruth(inputs)
  const missingData = identifyMissingData(inputs)
  const bottleneck = prioritizeBottleneck(inputs)
  const { options, recommendedOption } = proposeOptions(bottleneck, inputs)
  return {
    businessTruth,
    missingData,
    bottleneck,
    options,
    recommendedOption,
    planSkeleton: buildPlanSkeleton(options[recommendedOption], bottleneck),
  }
}

// ---------------------------------------------------------------------------
// Durable graph mirror (fail-open, same discipline as plan-run-graph)
// ---------------------------------------------------------------------------

export interface StrategyThreadEvent {
  step: 'proposal' | 'owner_decision'
  proposal?: StrategyProposal
  decision?: { briefId: string; decision: 'approved' | 'rejected'; note?: string }
  eventNo?: number
}

const GrowthStrategyState = Annotation.Root({
  event: Annotation<StrategyThreadEvent | null>({ reducer: (_a, b) => b, default: () => null }),
  eventCount: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
})

function buildGraph(checkpointer: NonNullable<ReturnType<typeof getGraphCheckpointer>>) {
  return new StateGraph(GrowthStrategyState)
    .addNode('apply_event', (s) => ({
      eventCount: 1,
      event: s.event ? { ...s.event, eventNo: s.eventCount + 1 } : null,
    }))
    .addEdge(START, 'apply_event')
    .addEdge('apply_event', END)
    .compile({ checkpointer })
}

function threadConfig(businessId: string) {
  return checkpointConfigFor({ conversationId: `growth:${businessId}`, turnId: null, namespace: GROWTH_STRATEGY_NS })
}

async function mirrorEvent(businessId: string, event: StrategyThreadEvent): Promise<void> {
  try {
    if (!isWorkflowGraphEnabled()) return
    const checkpointer = getGraphCheckpointer()
    if (!checkpointer) return
    await buildGraph(checkpointer).invoke({ event }, threadConfig(businessId))
  } catch (err) {
    console.warn('[growth-strategy-graph] mirror failed open:', err instanceof Error ? err.message : err)
  }
}

/**
 * Run the strategy flow: assemble the proposal from live inputs and mirror it
 * onto the durable `growth:<businessId>` thread. The owner decision happens
 * afterwards (approveBrief + recordOwnerDecision resumes the same thread).
 */
export async function runStrategyFlow(businessId: string, inputs: StrategyInputs): Promise<StrategyProposal> {
  const proposal = assembleProposal(inputs)
  await mirrorEvent(businessId, { step: 'proposal', proposal })
  return proposal
}

/** Stamp the owner's decision onto the same durable thread (called after approveBrief). */
export async function recordOwnerDecision(
  businessId: string,
  decision: { briefId: string; decision: 'approved' | 'rejected'; note?: string },
): Promise<void> {
  await mirrorEvent(businessId, { step: 'owner_decision', decision })
}
