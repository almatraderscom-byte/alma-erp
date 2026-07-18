/**
 * Phase 57 — the STAGED AUTONOMY LADDER.
 *
 * Per task class (autonomy-task-catalog TASK_FAMILIES) and exact scope, a
 * capability climbs:
 *
 *   off → shadow → suggest → draft → auto_r1 → bounded_r2
 *
 * R3/R4 families are CAPPED below auto (draft at most / shadow for R4) —
 * point-of-risk approval and owner-only execution never get delegated by a
 * ladder switch. There is deliberately NO "auto everything" API: every
 * function takes ONE task class, promotion moves ONE rung, and each
 * promotion requires the Phase 57 readiness gate + explicit owner approval.
 *
 * Auto-rollback: recorded failures inside the rolling window demote the class
 * one rung immediately and reset its readiness evidence.
 *
 * State lives in agent_kv_settings (`autonomy_rollout:<class>`) through the
 * same injectable KV as autonomy-readiness.ts.
 */
import { TASK_FAMILIES, type RiskTier } from '@/agent/lib/autonomy-task-catalog'
import {
  DEFAULT_READINESS_TARGETS,
  evaluateReadiness,
  getReadinessEvidence,
  resetReadinessEvidence,
  type ReadinessKv,
  type ReadinessTargets,
  defaultReadinessKv,
} from './autonomy-readiness'

export const LADDER_STAGES = ['off', 'shadow', 'suggest', 'draft', 'auto_r1', 'bounded_r2'] as const
export type LadderStage = (typeof LADDER_STAGES)[number]

export const STAGE_LABEL_BN: Record<LadderStage, string> = {
  off: 'বন্ধ — এই ধরনের কাজে এজেন্ট কিছুই করবে না',
  shadow: 'ছায়া — এজেন্ট শুধু ভেতরে ভেতরে সিদ্ধান্ত লিখে রাখবে, কিছু করবে না',
  suggest: 'পরামর্শ — “এটা করা যায়” বলে জানাবে, করবে না',
  draft: 'খসড়া — কাজটা সাজিয়ে approval কার্ড দেবে, Boss অনুমোদন দিলে হবে',
  auto_r1: 'স্বয়ংক্রিয় (ছোট কাজ) — ফেরানো-যোগ্য ছোট কাজ নিজে করবে, হিসাব রাখবে',
  bounded_r2: 'সীমিত স্বয়ংক্রিয় — Boss-এর বেঁধে দেওয়া সীমার ভেতরে মাঝারি কাজও করবে, জানিয়ে',
}

/** Max ladder rung a family may EVER reach, by its risk tier. */
export function maxStageForTier(tier: RiskTier): LadderStage {
  switch (tier) {
    case 'R0':
    case 'R1':
      return 'auto_r1'
    case 'R2':
      return 'bounded_r2'
    case 'R3':
      return 'draft' // point-of-risk approval stays — draft is the ceiling
    case 'R4':
      return 'shadow' // owner-only: the agent may only observe
  }
}

export interface RolloutScope {
  dailyCount: number
  moneyCapTaka: number
  /** Local quiet hours [startHour, endHour) in Asia/Dhaka when nothing auto-fires. */
  quietHours: [number, number] | null
  /** Canary percentage of eligible actions that actually use the new stage. */
  canaryPct: number
  /** ISO expiry — a stage grant is never open-ended. */
  expiresAt: string | null
  notify: 'before' | 'after' | 'both'
}

export const DEFAULT_SCOPE: RolloutScope = {
  dailyCount: 5,
  moneyCapTaka: 0,
  quietHours: [23, 7],
  canaryPct: 20,
  expiresAt: null,
  notify: 'both',
}

export interface TaskClassRollout {
  taskClass: string
  stage: LadderStage
  scope: RolloutScope
  autoRollback: { maxFailures: number; windowHours: number }
  /** Failure timestamps inside the rolling window. */
  recentFailures: string[]
  approvedBy: string | null
  updatedAt: string
}

const KEY_PREFIX = 'autonomy_rollout:'

function defaults(taskClass: string): TaskClassRollout {
  return {
    taskClass,
    stage: 'off',
    scope: { ...DEFAULT_SCOPE },
    autoRollback: { maxFailures: 2, windowHours: 24 },
    recentFailures: [],
    approvedBy: null,
    updatedAt: new Date(0).toISOString(),
  }
}

export function isKnownTaskClass(taskClass: string): boolean {
  return TASK_FAMILIES.some((f) => f.id === taskClass)
}

function tierOfClass(taskClass: string): RiskTier {
  return TASK_FAMILIES.find((f) => f.id === taskClass)?.tier ?? 'R3'
}

export async function getRollout(taskClass: string, kv: ReadinessKv = defaultReadinessKv()): Promise<TaskClassRollout> {
  try {
    const raw = await kv.get(`${KEY_PREFIX}${taskClass}`)
    if (!raw) return defaults(taskClass)
    const parsed = JSON.parse(raw) as Partial<TaskClassRollout>
    return { ...defaults(taskClass), ...parsed, scope: { ...DEFAULT_SCOPE, ...(parsed.scope ?? {}) } }
  } catch {
    return defaults(taskClass) // unreadable state = most cautious (off)
  }
}

async function saveRollout(r: TaskClassRollout, kv: ReadinessKv): Promise<void> {
  await kv.set(`${KEY_PREFIX}${r.taskClass}`, JSON.stringify({ ...r, updatedAt: new Date().toISOString() }))
}

export interface PromotionResult {
  ok: boolean
  rollout: TaskClassRollout
  blockers: string[]
}

/**
 * Promote ONE task class ONE rung. Requires:
 *   • the next rung within the family's tier ceiling
 *   • the readiness gate passing on accumulated evidence
 *   • an explicit approving owner note
 * There is no batch/promote-all API — by design.
 */
export async function promoteTaskClass(
  taskClass: string,
  approvedBy: string,
  opts: { targets?: ReadinessTargets; kv?: ReadinessKv } = {},
): Promise<PromotionResult> {
  const kv = opts.kv ?? defaultReadinessKv()
  if (!isKnownTaskClass(taskClass)) {
    return { ok: false, rollout: defaults(taskClass), blockers: [`অজানা task class: ${taskClass}`] }
  }
  if (!approvedBy || approvedBy.trim().length === 0) {
    return { ok: false, rollout: await getRollout(taskClass, kv), blockers: ['Boss-এর অনুমোদন নোট লাগবে'] }
  }

  const rollout = await getRollout(taskClass, kv)
  const idx = LADDER_STAGES.indexOf(rollout.stage)
  if (idx === LADDER_STAGES.length - 1) {
    return { ok: false, rollout, blockers: ['ইতিমধ্যে সর্বোচ্চ ধাপে আছে'] }
  }
  const next = LADDER_STAGES[idx + 1]
  const ceiling = maxStageForTier(tierOfClass(taskClass))
  if (LADDER_STAGES.indexOf(next) > LADDER_STAGES.indexOf(ceiling)) {
    return { ok: false, rollout, blockers: [`এই শ্রেণির সর্বোচ্চ ধাপ "${STAGE_LABEL_BN[ceiling]}" — R3/R4 কখনো স্বয়ংক্রিয় হয় না`] }
  }

  // shadow is the free first rung (observation only); everything above needs evidence.
  if (next !== 'shadow') {
    const evidence = await getReadinessEvidence(taskClass, kv)
    const verdict = evaluateReadiness(evidence, opts.targets ?? DEFAULT_READINESS_TARGETS)
    if (!verdict.ready) return { ok: false, rollout, blockers: verdict.blockers }
  }

  const promoted: TaskClassRollout = { ...rollout, stage: next, approvedBy, recentFailures: [] }
  await saveRollout(promoted, kv)
  // Fresh rung = fresh evidence requirement for the NEXT promotion.
  await resetReadinessEvidence(taskClass, `promoted to ${next}`, `p57:${next}`, kv)
  return { ok: true, rollout: promoted, blockers: [] }
}

/** Demote/pause — takes effect for the very next decision (no cache in this path). */
export async function demoteTaskClass(
  taskClass: string,
  toStage: LadderStage,
  reason: string,
  kv: ReadinessKv = defaultReadinessKv(),
): Promise<TaskClassRollout> {
  const rollout = await getRollout(taskClass, kv)
  const target = LADDER_STAGES.indexOf(toStage) < LADDER_STAGES.indexOf(rollout.stage) ? toStage : rollout.stage
  const demoted: TaskClassRollout = { ...rollout, stage: target, recentFailures: [] }
  await saveRollout(demoted, kv)
  await resetReadinessEvidence(taskClass, `demoted: ${reason}`, `p57:${target}`, kv)
  return demoted
}

export interface OutcomeRecord {
  ok: boolean
  /** Owner corrected/undid the action. */
  ownerCorrected?: boolean
  critical?: boolean
}

/**
 * Record a live outcome for a class. Failures inside the rolling window breach
 * the auto-rollback threshold → immediate one-rung demotion + evidence reset.
 */
export async function recordRolloutOutcome(
  taskClass: string,
  outcome: OutcomeRecord,
  opts: { now?: Date; kv?: ReadinessKv } = {},
): Promise<{ rollout: TaskClassRollout; rolledBack: boolean }> {
  const kv = opts.kv ?? defaultReadinessKv()
  const now = opts.now ?? new Date()
  const rollout = await getRollout(taskClass, kv)

  if (outcome.ok && !outcome.ownerCorrected) {
    return { rollout, rolledBack: false }
  }

  const windowMs = rollout.autoRollback.windowHours * 3600_000
  const failures = [...rollout.recentFailures.filter((t) => now.getTime() - new Date(t).getTime() < windowMs), now.toISOString()]

  if (outcome.critical || failures.length >= rollout.autoRollback.maxFailures) {
    const idx = LADDER_STAGES.indexOf(rollout.stage)
    const down = LADDER_STAGES[Math.max(0, idx - 1)]
    const demoted = await demoteTaskClass(taskClass, down, outcome.critical ? 'critical failure' : 'auto-rollback threshold', kv)
    return { rollout: demoted, rolledBack: idx > 0 }
  }

  const updated: TaskClassRollout = { ...rollout, recentFailures: failures }
  await saveRollout(updated, kv)
  return { rollout: updated, rolledBack: false }
}

/**
 * The runtime question: how may this class act RIGHT NOW? Reads the ladder
 * fresh (no cache) so a revoke/pause applies before the next tool execution.
 * Expired grants and quiet hours degrade to the safe rung.
 */
export async function effectiveStage(
  taskClass: string,
  opts: { now?: Date; kv?: ReadinessKv } = {},
): Promise<{ stage: LadderStage; reason: string }> {
  const kv = opts.kv ?? defaultReadinessKv()
  const now = opts.now ?? new Date()
  const rollout = await getRollout(taskClass, kv)

  if (rollout.scope.expiresAt && now.toISOString() > rollout.scope.expiresAt) {
    return { stage: 'draft', reason: 'অনুমতির মেয়াদ শেষ — খসড়া ধাপে নেমে গেছে' }
  }
  if ((rollout.stage === 'auto_r1' || rollout.stage === 'bounded_r2') && rollout.scope.quietHours) {
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', hour12: false }).format(now))
    const [start, end] = rollout.scope.quietHours
    const inQuiet = start <= end ? hour >= start && hour < end : hour >= start || hour < end
    if (inQuiet) return { stage: 'draft', reason: 'শান্ত সময় (quiet hours) — এখন কিছু স্বয়ংক্রিয় হবে না' }
  }
  return { stage: rollout.stage, reason: STAGE_LABEL_BN[rollout.stage] }
}

// ── Phase 64: ladder → guard verdict (pure) ──────────────────────────────────

export type LadderGuardVerdict = 'allow' | 'stage' | 'block'

/**
 * How a task class's effective ladder stage governs an AGENT-INITIATED action
 * inside the central guard. Owner-direct actions are governed by the base guard
 * (normal authorization), NOT the ladder — this is only reached for model /
 * scheduler initiative. Reads are never gated by the ladder.
 *
 *   off / shadow / suggest → block  (the agent may not create the effect)
 *   draft                  → stage  (a private/reversible draft or approval card)
 *   auto_r1 / bounded_r2   → allow  (within the scope limits the guard enforces)
 *
 * This can only ever TIGHTEN the base guard decision — it never loosens it.
 */
export function ladderGuardVerdict(
  stage: LadderStage,
  mode: 'read' | 'stage' | 'write',
  isOwnerDirect: boolean,
): LadderGuardVerdict {
  if (isOwnerDirect) return 'allow'
  if (mode === 'read') return 'allow'
  switch (stage) {
    case 'off':
    case 'shadow':
    case 'suggest':
      return 'block'
    case 'draft':
      return 'stage'
    case 'auto_r1':
    case 'bounded_r2':
      return 'allow'
  }
}

/**
 * Ladder enforcement mode: 'off' disables it; 'shadow' computes + records but
 * does not change execution; 'on' enforces the tightening. Unset → ON in Vercel
 * preview (so exit-gate "a rung change flips the guard decision" is testable),
 * SHADOW in production (the ladder attaches to the trace but changes nothing
 * until the owner flips it — every task class also stays 'off' by default).
 */
export function ladderEnforcementMode(
  flag = process.env.AGENT_AUTONOMY_LADDER,
  vercelEnv = process.env.VERCEL_ENV,
): 'off' | 'shadow' | 'on' {
  if (flag === 'off' || flag === 'false') return 'off'
  if (flag === 'on' || flag === 'true') return 'on'
  if (flag === 'shadow') return 'shadow'
  return vercelEnv === 'preview' ? 'on' : 'shadow'
}

/** Full ladder view for the control centre. */
export async function listRollouts(kv: ReadinessKv = defaultReadinessKv()): Promise<
  Array<TaskClassRollout & { tier: RiskTier; ceiling: LadderStage; labelBn: string }>
> {
  const out = []
  for (const f of TASK_FAMILIES) {
    const rollout = await getRollout(f.id, kv)
    out.push({ ...rollout, tier: f.tier, ceiling: maxStageForTier(f.tier), labelBn: f.label })
  }
  return out
}
