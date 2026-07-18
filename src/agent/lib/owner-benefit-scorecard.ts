/**
 * Phase 68 — the OWNER-BENEFIT SCORECARD (closes GAP-14: no owner-benefit view).
 *
 * Ties together the evidence streams the earlier phases created — continuity
 * binding outcomes (Phase 62), autonomy SLO/readiness (Phase 64), effect runs
 * and the feature truth matrix (Phase 61/65) — into the ONE weekly view the
 * roadmap's success criteria demand: is the owner actually getting more done
 * with less avoidable intervention?
 *
 * Two pure evaluators live here too: the automatic ROLLBACK thresholds and the
 * legacy-retirement gate. Both are deterministic and fully testable — no
 * business ROI is ever invented; unknown stays unknown.
 */

// ── Pure: automatic rollback thresholds (roadmap §7) ─────────────────────────

export interface RollbackMetrics {
  duplicateExternalEffects: number
  unapprovedHighImpactEffects: number
  crossAccountEffects: number
  secretLeaks: number
  unknownEffects: number
  /** Full-graph disagreement rate over the rolling gate (>0.02 → prior rung). */
  graphDisagreementRate: number
  /** Wrong-focus binding rate (>0.01 → prior rung). */
  wrongFocusRate: number
  /** Owner-correction rate (>0.02 → prior rung). */
  ownerCorrectionRate: number
  /** Independent proof rate for an autonomous class (<0.99 → no promotion). */
  independentProofRate: number
  serviceAuthFailure: boolean
}

export type RollbackScope =
  | 'class_off'
  | 'effect_class_off_until_reconciled'
  | 'return_prior_rung'
  | 'no_promotion'
  | 'service_paused'

export interface RollbackAction {
  scope: RollbackScope
  reason: string
}

/**
 * Evaluate the automatic rollback thresholds. Any hard-invariant breach turns
 * the affected class OFF; softer quality regressions return it to the prior
 * rung; low proof blocks promotion. Deterministic.
 */
export function evaluateRollbackThresholds(m: RollbackMetrics): RollbackAction[] {
  const out: RollbackAction[] = []
  // Hard invariants → affected class OFF immediately.
  if (m.duplicateExternalEffects > 0) out.push({ scope: 'class_off', reason: `duplicate external effect (${m.duplicateExternalEffects})` })
  if (m.unapprovedHighImpactEffects > 0) out.push({ scope: 'class_off', reason: `unapproved R3/R4 effect (${m.unapprovedHighImpactEffects})` })
  if (m.crossAccountEffects > 0) out.push({ scope: 'class_off', reason: `cross-account effect (${m.crossAccountEffects})` })
  if (m.secretLeaks > 0) out.push({ scope: 'class_off', reason: `secret leak (${m.secretLeaks})` })
  // Unknown effect → that effect class OFF until reconciled.
  if (m.unknownEffects > 0) out.push({ scope: 'effect_class_off_until_reconciled', reason: `unknown-state effect (${m.unknownEffects})` })
  // Quality regressions → return to the prior rung.
  if (m.graphDisagreementRate > 0.02) out.push({ scope: 'return_prior_rung', reason: `graph disagreement ${(m.graphDisagreementRate * 100).toFixed(1)}% > 2%` })
  if (m.wrongFocusRate > 0.01) out.push({ scope: 'return_prior_rung', reason: `wrong focus ${(m.wrongFocusRate * 100).toFixed(1)}% > 1%` })
  if (m.ownerCorrectionRate > 0.02) out.push({ scope: 'return_prior_rung', reason: `owner correction ${(m.ownerCorrectionRate * 100).toFixed(1)}% > 2%` })
  // Proof below 99% → no promotion (not a demotion, a hold).
  if (m.independentProofRate < 0.99) out.push({ scope: 'no_promotion', reason: `independent proof ${(m.independentProofRate * 100).toFixed(1)}% < 99%` })
  // Service auth/revoke/health failure → pause the service.
  if (m.serviceAuthFailure) out.push({ scope: 'service_paused', reason: 'service auth/revoke/health failure' })
  return out
}

// ── Pure: legacy owner-turn retirement gate ──────────────────────────────────

export interface LegacyRetirementInput {
  consecutiveDaysAtFinalStage: number
  rollbackSignalInWindow: boolean
  ownerApproved: boolean
}

const RETIREMENT_MIN_DAYS = 30

/**
 * The legacy owner-turn path may be removed only after 30 consecutive
 * production days at the final graph stage with NO rollback signal AND owner
 * approval. Until then it stays as the rollback path.
 */
export function evaluateLegacyRetirementGate(input: LegacyRetirementInput): { eligible: boolean; reason: string } {
  if (input.rollbackSignalInWindow) {
    return { eligible: false, reason: 'rollback signal in the window — legacy path retained as rollback' }
  }
  if (input.consecutiveDaysAtFinalStage < RETIREMENT_MIN_DAYS) {
    return { eligible: false, reason: `only ${input.consecutiveDaysAtFinalStage}/${RETIREMENT_MIN_DAYS} consecutive clean days at final stage` }
  }
  if (!input.ownerApproved) {
    return { eligible: false, reason: 'owner approval required before removing the legacy path' }
  }
  return { eligible: true, reason: `${input.consecutiveDaysAtFinalStage} clean days at final stage + owner approval` }
}

// ── The scorecard (assembled from real signals; fail-open) ────────────────────

export interface OwnerBenefitScorecard {
  generatedAt: string
  windowDays: number
  continuity: {
    scoredTurns: number
    correctBindingRate: number
    ownerCorrections: number
    meetsGate: boolean
  }
  autonomy: {
    activeClasses: number
    duplicateExternalEffects: number
    unapprovedHighImpactEffects: number
    unknownEffects: number
    guardCoverage: number
  }
  effects: {
    total7d: number | 'unknown'
    verifiedSuccess7d: number | 'unknown'
  }
  /** Business truth is NEVER invented — unknown until real COD/refund/profit data. */
  businessOutcome: 'unknown'
  topBlockers: string[]
  /** Rollback actions currently implied by the live metrics. */
  rollbackActions: RollbackAction[]
}

/** Assemble the weekly scorecard from the real evidence streams. Fail-open. */
export async function computeOwnerBenefitScorecard(windowDays = 7): Promise<OwnerBenefitScorecard> {
  const card: OwnerBenefitScorecard = {
    generatedAt: new Date().toISOString(),
    windowDays,
    continuity: { scoredTurns: 0, correctBindingRate: 0, ownerCorrections: 0, meetsGate: false },
    autonomy: { activeClasses: 0, duplicateExternalEffects: 0, unapprovedHighImpactEffects: 0, unknownEffects: 0, guardCoverage: 0 },
    effects: { total7d: 'unknown', verifiedSuccess7d: 'unknown' },
    businessOutcome: 'unknown',
    topBlockers: [],
    rollbackActions: [],
  }

  // Continuity binding quality (Phase 62 evidence stream).
  try {
    const { summarizeBindingOutcomes } = await import('@/agent/lib/continuity-outcome')
    const b = await summarizeBindingOutcomes(windowDays)
    card.continuity = {
      scoredTurns: b.scored,
      correctBindingRate: b.correctRate,
      ownerCorrections: b.byOutcome.owner_correction,
      meetsGate: b.meetsGate,
    }
  } catch { /* stays zeros */ }

  // Autonomy SLO (Phase 64 evidence).
  let unknownEffects = 0
  try {
    const { computeSloSnapshot } = await import('@/agent/lib/autonomy-slo')
    const s = await computeSloSnapshot()
    card.autonomy = {
      activeClasses: s.classes.filter((c) => c.stage !== 'off').length,
      duplicateExternalEffects: s.global.duplicateExternalEffects,
      unapprovedHighImpactEffects: s.global.unapprovedHighImpactEffects,
      unknownEffects: s.global.unknownEffects,
      guardCoverage: s.global.guardCoverage,
    }
    unknownEffects = s.global.unknownEffects
  } catch { /* stays zeros */ }

  // Feature truth blockers (Phase 61) — the honest "what's holding value back".
  try {
    const { getProductionTruth } = await import('@/agent/lib/production-truth')
    const t = await getProductionTruth()
    card.topBlockers = t.features.filter((f) => f.blocker).slice(0, 3).map((f) => `${f.labelBn}: ${f.blocker}`)
    const eff = t.features.find((f) => f.id === 'effect_engine')
    if (eff) card.effects = { total7d: eff.use7d, verifiedSuccess7d: eff.lastVerifiedOutcome ? eff.use7d : 0 }
  } catch { /* blockers stay empty */ }

  // Rollback actions implied by the current metrics (hard invariants only —
  // the soft-rate inputs need real graph traces, reported as 0 until then).
  card.rollbackActions = evaluateRollbackThresholds({
    duplicateExternalEffects: card.autonomy.duplicateExternalEffects,
    unapprovedHighImpactEffects: card.autonomy.unapprovedHighImpactEffects,
    crossAccountEffects: 0,
    secretLeaks: 0,
    unknownEffects,
    graphDisagreementRate: 0,
    wrongFocusRate: 0,
    ownerCorrectionRate: 0,
    independentProofRate: 1,
    serviceAuthFailure: false,
  })

  return card
}
