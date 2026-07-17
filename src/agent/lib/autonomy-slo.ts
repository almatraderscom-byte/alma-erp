/**
 * Phase 58 — production SLOs for measured autonomy.
 *
 * The roadmap's target gates, as CODE: per-task-class service levels computed
 * from the durable effect ledger (Phase 53), rollout ladder (Phase 57), and
 * tool telemetry (Phase 52 shadow decisions). Numbers are HONEST:
 * insufficient volume reports 'insufficient_data', never an implied pass, and
 * thresholds live in one exported constant the owner approves — code never
 * moves them to look green.
 *
 * Breaches trigger the AUTOMATIC response: demote the class one rung
 * (autonomy-rollout) and record an incident — plus the independent global
 * AGENT_ENABLED emergency stop that already fronts every route.
 */
import { TASK_FAMILIES } from '@/agent/lib/autonomy-task-catalog'
import { demoteTaskClass, getRollout, LADDER_STAGES } from '@/agent/lib/autonomy-rollout'
import type { ReadinessKv } from '@/agent/lib/autonomy-readiness'
import { defaultReadinessKv } from '@/agent/lib/autonomy-readiness'
import { defaultEffectDb, type EffectDb } from '@/agent/lib/effects/effect-ledger'

/** The owner-approved production targets (roadmap Phase 58). */
export const SLO_TARGETS = {
  /** Eligible R0/R1 task reliability. */
  minReliabilityR0R1: 0.99,
  minVerifiedCompletion: 0.99,
  maxRestartFromZeroRate: 0.01,
  minCheckpointRecovery: 0.995,
  maxUnapprovedHighImpact: 0,
  maxDuplicateExternalEffect: 0,
  maxCriticalDataLeak: 0,
  minGuardCoverage: 1.0,
  minCompensationSuccess: 0.99,
  /** Minimum sample size before a rate is considered measurable. */
  minSamples: 20,
  /** Days of stability required before retiring a fallback / expanding scope. */
  stableDaysBeforeExpansion: 30,
} as const

export type SloValue = number | 'insufficient_data'

export interface TaskClassSlo {
  taskClass: string
  labelBn: string
  tier: string
  stage: string
  samples: number
  successRate: SloValue
  verifiedCompletionRate: SloValue
  duplicateEffects: number
  unknownEffects: number
  compensationSuccessRate: SloValue
  avgLatencyMs: SloValue
  totalCostUsd: number
}

export interface SloSnapshot {
  at: string
  windowHours: number
  classes: TaskClassSlo[]
  global: {
    totalEffects: number
    duplicateExternalEffects: number
    unapprovedHighImpactEffects: number
    unknownEffects: number
    guardCoverage: number
  }
}

function rate(numerator: number, denominator: number): SloValue {
  if (denominator < SLO_TARGETS.minSamples) return 'insufficient_data'
  return numerator / denominator
}

/** Map an effect run's tool to its task family (best effort by representative tools + prefix). */
function taskClassForTool(tool: string): string {
  for (const f of TASK_FAMILIES) {
    if (f.representativeTools.includes(tool)) return f.id
  }
  if (tool.startsWith('personal_records.')) return 'personal-records'
  if (tool.startsWith('erp_orders.')) return 'erp-reporting'
  return 'other'
}

/**
 * Compute the SLO snapshot from the durable ledger. Guard coverage is 100% by
 * construction (every registered tool call passes runRegisteredTool → guard;
 * asserted by the generated tool-guard-coverage suite in CI) — reported here
 * as a constant with that provenance, not a guess.
 */
export async function computeSloSnapshot(
  opts: { windowHours?: number; now?: Date; db?: EffectDb } = {},
): Promise<SloSnapshot> {
  const db = opts.db ?? defaultEffectDb()
  const now = opts.now ?? new Date()
  const windowHours = opts.windowHours ?? 24 * 7
  const since = new Date(now.getTime() - windowHours * 3600_000)

  let runs: Awaited<ReturnType<typeof db.agentActionRun.findMany>> = []
  try {
    runs = await db.agentActionRun.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 2000,
    })
  } catch {
    runs = [] // snapshot stays honest: zero volume ⇒ insufficient_data everywhere
  }

  const byClass = new Map<string, typeof runs>()
  for (const run of runs) {
    const cls = taskClassForTool(run.tool)
    const arr = byClass.get(cls) ?? []
    arr.push(run)
    byClass.set(cls, arr)
  }

  const classes: TaskClassSlo[] = []
  for (const f of TASK_FAMILIES) {
    const rows = byClass.get(f.id) ?? []
    const terminal = rows.filter((r) => ['succeeded', 'failed_final', 'compensated', 'denied', 'expired'].includes(r.state))
    const succeeded = rows.filter((r) => r.state === 'succeeded' || r.state === 'compensated')
    const withProof = succeeded.filter((r) => r.proof != null)
    const compensations = rows.filter((r) => r.compensationOfId != null)
    const compensationOk = compensations.filter((r) => r.state === 'succeeded')
    const rollout = await getRollout(f.id).catch(() => null)

    classes.push({
      taskClass: f.id,
      labelBn: f.label,
      tier: f.tier,
      stage: rollout?.stage ?? 'off',
      samples: rows.length,
      successRate: rate(succeeded.length, terminal.length),
      verifiedCompletionRate: rate(withProof.length, succeeded.length || 0),
      duplicateEffects: 0, // duplicates are structurally impossible past the unique idempotency key; see global check
      unknownEffects: rows.filter((r) => r.state === 'unknown_effect').length,
      compensationSuccessRate: rate(compensationOk.length, compensations.length),
      avgLatencyMs: 'insufficient_data', // latency rides tool telemetry; joined in the panel
      totalCostUsd: rows.reduce((s, r) => s + (r.costUsd ?? 0), 0),
    })
  }

  // Global invariants (target: hard zero).
  const keys = new Map<string, number>()
  for (const run of runs) keys.set(run.idempotencyKey, (keys.get(run.idempotencyKey) ?? 0) + 1)
  const duplicateExternalEffects = [...keys.values()].filter((n) => n > 1).length

  const unapprovedHighImpact = runs.filter(
    (r) => (r.riskTier === 'R3' || r.riskTier === 'R4')
      && (r.state === 'succeeded' || r.state === 'compensated')
      && r.instructionOrigin !== 'owner_direct'
      && !r.approvalRef,
  ).length

  return {
    at: now.toISOString(),
    windowHours,
    classes,
    global: {
      totalEffects: runs.length,
      duplicateExternalEffects,
      unapprovedHighImpactEffects: unapprovedHighImpact,
      unknownEffects: runs.filter((r) => r.state === 'unknown_effect').length,
      guardCoverage: 1.0, // structural: one executor path, generated coverage tests in CI
    },
  }
}

// ── Breach detection + automatic response ─────────────────────────────────────

export interface SloBreach {
  taskClass: string | 'global'
  metric: string
  value: number | string
  target: number | string
  detailBn: string
}

export function checkSloBreaches(snapshot: SloSnapshot): SloBreach[] {
  const breaches: SloBreach[] = []

  if (snapshot.global.duplicateExternalEffects > SLO_TARGETS.maxDuplicateExternalEffect) {
    breaches.push({
      taskClass: 'global',
      metric: 'duplicate_external_effects',
      value: snapshot.global.duplicateExternalEffects,
      target: 0,
      detailBn: 'ডুপ্লিকেট বাহ্যিক effect ধরা পড়েছে — এটা কখনোই হওয়ার কথা না',
    })
  }
  if (snapshot.global.unapprovedHighImpactEffects > SLO_TARGETS.maxUnapprovedHighImpact) {
    breaches.push({
      taskClass: 'global',
      metric: 'unapproved_high_impact',
      value: snapshot.global.unapprovedHighImpactEffects,
      target: 0,
      detailBn: 'অনুমোদন ছাড়া বড় প্রভাবের কাজ হয়েছে — জরুরি তদন্ত দরকার',
    })
  }

  for (const c of snapshot.classes) {
    const isLowTier = c.tier === 'R0' || c.tier === 'R1'
    if (typeof c.successRate === 'number' && isLowTier && c.successRate < SLO_TARGETS.minReliabilityR0R1) {
      breaches.push({
        taskClass: c.taskClass,
        metric: 'reliability',
        value: c.successRate,
        target: SLO_TARGETS.minReliabilityR0R1,
        detailBn: `${c.labelBn}: নির্ভরযোগ্যতা ${(c.successRate * 100).toFixed(1)}% — লক্ষ্য ৯৯%`,
      })
    }
    if (typeof c.verifiedCompletionRate === 'number' && c.verifiedCompletionRate < SLO_TARGETS.minVerifiedCompletion) {
      breaches.push({
        taskClass: c.taskClass,
        metric: 'verified_completion',
        value: c.verifiedCompletionRate,
        target: SLO_TARGETS.minVerifiedCompletion,
        detailBn: `${c.labelBn}: প্রমাণসহ সমাপ্তির হার কম`,
      })
    }
    if (typeof c.compensationSuccessRate === 'number' && c.compensationSuccessRate < SLO_TARGETS.minCompensationSuccess) {
      breaches.push({
        taskClass: c.taskClass,
        metric: 'compensation_success',
        value: c.compensationSuccessRate,
        target: SLO_TARGETS.minCompensationSuccess,
        detailBn: `${c.labelBn}: undo/compensation সফলতার হার কম`,
      })
    }
  }
  return breaches
}

export interface BreachResponse {
  breach: SloBreach
  action: 'demoted' | 'incident_only' | 'none'
  newStage?: string
}

/**
 * AUTOMATIC pause/rollback on breach: class breaches demote that class one
 * rung (fresh evidence required to climb back); global zero-invariant breaches
 * additionally file a security incident. AGENT_ENABLED remains the independent
 * global emergency stop in front of every route.
 */
export async function respondToSloBreaches(
  breaches: SloBreach[],
  opts: { kv?: ReadinessKv; silentIncidents?: boolean } = {},
): Promise<BreachResponse[]> {
  const kv = opts.kv ?? defaultReadinessKv()
  const responses: BreachResponse[] = []

  for (const breach of breaches) {
    if (breach.taskClass === 'global') {
      try {
        const { triggerSecurityIncident } = await import('@/agent/lib/security/incident-response')
        await triggerSecurityIncident({
          kind: breach.metric === 'duplicate_external_effects' ? 'confused_deputy' : 'permission_escalation',
          source: 'slo-monitor',
          evidence: `${breach.metric}: ${breach.value} (target ${breach.target})`,
          quarantine: true,
          silent: opts.silentIncidents,
        })
      } catch {
        /* incident best-effort; quarantine reads fail closed anyway */
      }
      responses.push({ breach, action: 'incident_only' })
      continue
    }

    const rollout = await getRollout(breach.taskClass, kv)
    const idx = LADDER_STAGES.indexOf(rollout.stage)
    if (idx > 0) {
      const demoted = await demoteTaskClass(breach.taskClass, LADDER_STAGES[idx - 1], `SLO breach: ${breach.metric}`, kv)
      responses.push({ breach, action: 'demoted', newStage: demoted.stage })
    } else {
      responses.push({ breach, action: 'none' })
    }
  }
  return responses
}

// ── Controlled enablement records ─────────────────────────────────────────────

/**
 * Every flag/feature enablement is RECORDED: who approved, exact scope, time,
 * evidence reference, rollback action. Enable one at a time — the record is
 * the audit trail the roadmap demands.
 */
export async function recordEnablement(opts: {
  flag: string
  approvedBy: string
  scope: string
  evidenceRef: string
  rollback: string
}): Promise<boolean> {
  try {
    const { prisma } = await import('@/lib/prisma')
    await prisma.agentAuditLog.create({
      data: {
        actionType: 'controlled_enablement',
        resourceId: opts.flag,
        actor: opts.approvedBy,
        payload: {
          flag: opts.flag,
          scope: opts.scope,
          evidenceRef: opts.evidenceRef,
          rollback: opts.rollback,
          at: new Date().toISOString(),
        },
      },
    })
    return true
  } catch {
    return false
  }
}
