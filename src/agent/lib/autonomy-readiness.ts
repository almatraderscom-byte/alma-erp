/**
 * Phase 57 — readiness gates: capability promotion by EVIDENCE, not enthusiasm.
 *
 * Before a task class climbs one rung of the autonomy ladder, its accumulated
 * evidence must clear every gate:
 *   minimum sample size · target correctness · recovery rate · proof rate ·
 *   ZERO critical guard failures · acceptable owner-correction rate ·
 *   cost budget · tested compensation · explicit owner approval (rollout.ts)
 *
 * Any policy/implementation/version change RESETS the evidence — the class
 * must re-prove itself through replay/shadow/canary before promotion again.
 *
 * Evidence lives in agent_kv_settings (`autonomy_readiness:<class>`) through
 * an injectable KV so tests run DB-free.
 */

export interface ReadinessEvidence {
  /** Shadow/canary decisions observed for this class. */
  samples: number
  /** Decisions whose outcome matched the constitutional expectation. */
  correct: number
  /** Interrupted attempts that recovered from checkpoint (Phase 54). */
  recoveries: number
  recoveryOpportunities: number
  /** Effects that stored independent postcondition proof (Phase 53). */
  proofs: number
  proofOpportunities: number
  criticalGuardFailures: number
  ownerCorrections: number
  costUsd: number
  compensationTested: boolean
  /** Version stamp of policy+implementation the evidence was gathered under. */
  version: string
}

export const EMPTY_EVIDENCE: ReadinessEvidence = {
  samples: 0,
  correct: 0,
  recoveries: 0,
  recoveryOpportunities: 0,
  proofs: 0,
  proofOpportunities: 0,
  criticalGuardFailures: 0,
  ownerCorrections: 0,
  costUsd: 0,
  compensationTested: false,
  version: 'p57.1',
}

export interface ReadinessTargets {
  minSamples: number
  minCorrectRate: number
  minRecoveryRate: number
  minProofRate: number
  maxOwnerCorrectionRate: number
  maxCostUsd: number
  requireCompensationTested: boolean
}

/** Conservative defaults — the owner may tighten, never silently loosen. */
export const DEFAULT_READINESS_TARGETS: ReadinessTargets = {
  minSamples: 25,
  minCorrectRate: 0.96,
  minRecoveryRate: 0.95,
  minProofRate: 0.95,
  maxOwnerCorrectionRate: 0.1,
  maxCostUsd: 20,
  requireCompensationTested: true,
}

export interface ReadinessVerdict {
  ready: boolean
  blockers: string[]
}

/** PURE gate evaluation — every blocker is owner-readable Bangla. */
export function evaluateReadiness(
  e: ReadinessEvidence,
  t: ReadinessTargets = DEFAULT_READINESS_TARGETS,
): ReadinessVerdict {
  const blockers: string[] = []
  if (e.samples < t.minSamples) blockers.push(`নমুনা কম: ${e.samples}/${t.minSamples} — আরো shadow/canary চালাতে হবে`)
  if (e.samples > 0 && e.correct / e.samples < t.minCorrectRate) {
    blockers.push(`সঠিকতার হার ${(e.correct / e.samples * 100).toFixed(1)}% — দরকার ${(t.minCorrectRate * 100).toFixed(0)}%`)
  }
  if (e.recoveryOpportunities > 0 && e.recoveries / e.recoveryOpportunities < t.minRecoveryRate) {
    blockers.push(`রিকভারি হার কম (${e.recoveries}/${e.recoveryOpportunities})`)
  }
  if (e.proofOpportunities > 0 && e.proofs / e.proofOpportunities < t.minProofRate) {
    blockers.push(`প্রমাণের হার কম (${e.proofs}/${e.proofOpportunities})`)
  }
  if (e.criticalGuardFailures > 0) blockers.push(`গুরুতর গার্ড ব্যর্থতা ${e.criticalGuardFailures}টি — শূন্য হতে হবে`)
  if (e.samples > 0 && e.ownerCorrections / e.samples > t.maxOwnerCorrectionRate) {
    blockers.push(`Boss-এর সংশোধন বেশি (${e.ownerCorrections}/${e.samples})`)
  }
  if (e.costUsd > t.maxCostUsd) blockers.push(`খরচ বাজেটের বেশি ($${e.costUsd.toFixed(2)} > $${t.maxCostUsd})`)
  if (t.requireCompensationTested && !e.compensationTested) blockers.push('undo/compensation এখনো টেস্ট করা হয়নি')
  return { ready: blockers.length === 0, blockers }
}

// ── KV persistence (injectable) ───────────────────────────────────────────────

export interface ReadinessKv {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
}

export function defaultReadinessKv(): ReadinessKv {
  return {
    get: async (key) => {
      const { prisma } = await import('@/lib/prisma')
      const row = await prisma.agentKvSetting.findUnique({ where: { key }, select: { value: true } })
      return row?.value ?? null
    },
    set: async (key, value) => {
      const { prisma } = await import('@/lib/prisma')
      await prisma.agentKvSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
    },
  }
}

const KEY_PREFIX = 'autonomy_readiness:'

export async function getReadinessEvidence(taskClass: string, kv: ReadinessKv = defaultReadinessKv()): Promise<ReadinessEvidence> {
  try {
    const raw = await kv.get(`${KEY_PREFIX}${taskClass}`)
    if (!raw) return { ...EMPTY_EVIDENCE }
    const parsed = JSON.parse(raw) as Partial<ReadinessEvidence>
    return { ...EMPTY_EVIDENCE, ...parsed }
  } catch {
    return { ...EMPTY_EVIDENCE }
  }
}

export async function recordReadinessEvidence(
  taskClass: string,
  delta: Partial<{
    samples: number
    correct: number
    recoveries: number
    recoveryOpportunities: number
    proofs: number
    proofOpportunities: number
    criticalGuardFailures: number
    ownerCorrections: number
    costUsd: number
    compensationTested: boolean
  }>,
  kv: ReadinessKv = defaultReadinessKv(),
): Promise<ReadinessEvidence> {
  const current = await getReadinessEvidence(taskClass, kv)
  const next: ReadinessEvidence = {
    ...current,
    samples: current.samples + (delta.samples ?? 0),
    correct: current.correct + (delta.correct ?? 0),
    recoveries: current.recoveries + (delta.recoveries ?? 0),
    recoveryOpportunities: current.recoveryOpportunities + (delta.recoveryOpportunities ?? 0),
    proofs: current.proofs + (delta.proofs ?? 0),
    proofOpportunities: current.proofOpportunities + (delta.proofOpportunities ?? 0),
    criticalGuardFailures: current.criticalGuardFailures + (delta.criticalGuardFailures ?? 0),
    ownerCorrections: current.ownerCorrections + (delta.ownerCorrections ?? 0),
    costUsd: current.costUsd + (delta.costUsd ?? 0),
    compensationTested: current.compensationTested || delta.compensationTested === true,
  }
  await kv.set(`${KEY_PREFIX}${taskClass}`, JSON.stringify(next))
  return next
}

/**
 * ANY policy/implementation/version change resets the class's evidence — the
 * ladder position may stay (rollout.ts decides demotion), but promotion is
 * blocked until the class re-proves itself under the new version.
 */
export async function resetReadinessEvidence(
  taskClass: string,
  reason: string,
  newVersion: string,
  kv: ReadinessKv = defaultReadinessKv(),
): Promise<ReadinessEvidence> {
  const fresh: ReadinessEvidence = { ...EMPTY_EVIDENCE, version: newVersion }
  await kv.set(`${KEY_PREFIX}${taskClass}`, JSON.stringify(fresh))
  void reason // recorded by callers in the rollout audit trail
  return fresh
}
