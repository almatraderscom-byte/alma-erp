/**
 * Phase 62 — continuity binding OUTCOME scoring.
 *
 * The resolver (continuity-resolver.ts) decides which work a message binds to.
 * This module scores whether that decision was *right* against what actually
 * happened, and records the result as durable real-production evidence so the
 * roadmap's binding-quality gate (≥98% correct binding over ≥100 scored real
 * owner turns) can be measured on real traffic — not synthetic fixtures.
 *
 * It also owns the ONE completion rule: a task is complete only when the claim
 * verifier AND the task postcondition both hold. Never from model prose.
 *
 * Pure functions here; the recorder writes a `__continuity__` tool event
 * (fail-open) so aggregation reuses the existing tool-telemetry store — no new
 * table (Phase 62 allowlist does not include a migration).
 */
import type { ContinuityBinding } from '@/agent/lib/continuity-resolver'

/** Real production binding outcomes the roadmap says to store and score. */
export type BindingOutcome =
  | 'continued_correct'
  | 'wrong_task'
  | 'unnecessary_restart'
  | 'duplicate_step'
  | 'asked_clarification'
  | 'owner_correction'

/** Observed signals for one turn's binding — all deterministic/booleans. */
export interface BindingObservation {
  binding: ContinuityBinding
  action: string
  /** This turn's owner message corrected the PRIOR turn's binding/effect. */
  ownerCorrectedPrior?: boolean
  /** The resolver bound to a task the owner did not mean (known this turn). */
  wrongTaskDetected?: boolean
  /** A verified/completed step or external effect was about to repeat. */
  duplicateStepDetected?: boolean
  /** Work already verified-complete was started over from zero. */
  restartedCompletedWork?: boolean
}

/**
 * Priority-ordered classifier. Owner correction is the strongest negative
 * signal (the owner had to intervene); a clean bind with no problem is
 * `continued_correct`. Deterministic — identical in prod, replay, and tests.
 */
export function scoreBindingOutcome(o: BindingObservation): BindingOutcome {
  if (o.ownerCorrectedPrior) return 'owner_correction'
  if (o.wrongTaskDetected) return 'wrong_task'
  if (o.duplicateStepDetected) return 'duplicate_step'
  if (o.restartedCompletedWork) return 'unnecessary_restart'
  if (o.binding === 'none' && o.action === 'clarify') return 'asked_clarification'
  return 'continued_correct'
}

/** The negative outcomes that count against the correct-binding rate. */
const NEGATIVE: ReadonlySet<BindingOutcome> = new Set<BindingOutcome>([
  'wrong_task',
  'unnecessary_restart',
  'duplicate_step',
  'owner_correction',
])

export function isBindingCorrect(outcome: BindingOutcome): boolean {
  // `asked_clarification` is honest (not a failure) but also not a "continued"
  // — it is neutral: excluded from the denominator by summarizeBindingOutcomes.
  return !NEGATIVE.has(outcome)
}

/**
 * The ONE completion rule. A focus/task is complete only when the claim
 * verifier passed AND the task's own postcondition is independently true.
 * Model prose ("done!", "পোস্ট হয়ে গেছে") can never satisfy this.
 */
export function canCompleteFocus(opts: { claimVerified: boolean; postconditionMet: boolean }): boolean {
  return opts.claimVerified === true && opts.postconditionMet === true
}

/**
 * Deterministic duplicate-step guard: would executing `step` repeat a step or
 * effect already recorded as verified-complete on the focus?
 */
export function wouldDuplicateStep(completedSteps: string[] | null | undefined, step: string): boolean {
  if (!step || !completedSteps?.length) return false
  const norm = (s: string) => s.trim().toLowerCase()
  const target = norm(step)
  return completedSteps.some((s) => norm(s) === target)
}

/**
 * Record a scored binding outcome as durable evidence (fail-open, non-blocking).
 * Stored on the shared tool-telemetry stream as `__continuity__` (phase=proof),
 * distinguished by toolName; detail.outcome carries the scored label.
 */
export async function recordBindingOutcome(opts: {
  conversationId: string
  businessId?: string
  turnId?: string | null
  observation: BindingObservation
  reason?: string
}): Promise<BindingOutcome> {
  const outcome = scoreBindingOutcome(opts.observation)
  try {
    const { logToolEvent } = await import('@/agent/lib/tool-telemetry')
    await logToolEvent({
      toolName: '__continuity__',
      phase: 'proof',
      success: isBindingCorrect(outcome),
      conversationId: opts.conversationId,
      businessId: opts.businessId,
      detail: {
        binding: opts.observation.binding,
        action: opts.observation.action,
        outcome,
        turnId: opts.turnId ?? null,
        reason: opts.reason ?? null,
      },
    })
  } catch (err) {
    console.warn('[continuity-outcome] record failed open:', err instanceof Error ? err.message : err)
  }
  return outcome
}

export interface BindingOutcomeSummary {
  days: number
  scored: number
  /** continued_correct + asked_clarification excluded from denominator. */
  denominator: number
  correct: number
  correctRate: number
  byOutcome: Record<BindingOutcome, number>
  /** Roadmap gate: ≥98% over ≥100 scored real owner turns. */
  meetsGate: boolean
}

const GATE_MIN_SCORED = 100
const GATE_MIN_RATE = 0.98

/**
 * Aggregate recorded binding outcomes into the real-evidence scorecard. Reads
 * the `__continuity__` binding events. Fail-open to an empty summary.
 */
export async function summarizeBindingOutcomes(days = 7): Promise<BindingOutcomeSummary> {
  const empty: BindingOutcomeSummary = {
    days,
    scored: 0,
    denominator: 0,
    correct: 0,
    correctRate: 0,
    byOutcome: {
      continued_correct: 0,
      wrong_task: 0,
      unnecessary_restart: 0,
      duplicate_step: 0,
      asked_clarification: 0,
      owner_correction: 0,
    },
    meetsGate: false,
  }
  try {
    const { prisma } = await import('@/lib/prisma')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = prisma as any
    const since = new Date(Date.now() - days * 86_400_000)
    const rows: Array<{ detail: unknown }> = await db.agentToolEvent.findMany({
      where: { toolName: '__continuity__', phase: 'proof', ts: { gte: since } },
      select: { detail: true },
      take: 5000,
    })
    for (const r of rows) {
      const outcome = (r.detail as { outcome?: BindingOutcome })?.outcome
      if (!outcome || !(outcome in empty.byOutcome)) continue
      empty.scored += 1
      empty.byOutcome[outcome] += 1
    }
    // Denominator excludes the neutral `asked_clarification` turns.
    empty.denominator = empty.scored - empty.byOutcome.asked_clarification
    empty.correct = empty.byOutcome.continued_correct
    empty.correctRate = empty.denominator ? empty.correct / empty.denominator : 0
    empty.meetsGate = empty.denominator >= GATE_MIN_SCORED && empty.correctRate >= GATE_MIN_RATE
    return empty
  } catch (err) {
    console.warn('[continuity-outcome] summary failed open:', err instanceof Error ? err.message : err)
    return empty
  }
}
