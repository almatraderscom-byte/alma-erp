import { describe, it, expect } from 'vitest'
import {
  evaluateRollbackThresholds,
  evaluateLegacyRetirementGate,
  computeOwnerBenefitScorecard,
  type RollbackMetrics,
} from '@/agent/lib/owner-benefit-scorecard'

/**
 * Phase 68 — the automatic rollback thresholds and the legacy-retirement gate
 * are deterministic; business ROI is never invented.
 */

const CLEAN: RollbackMetrics = {
  duplicateExternalEffects: 0,
  unapprovedHighImpactEffects: 0,
  crossAccountEffects: 0,
  secretLeaks: 0,
  unknownEffects: 0,
  graphDisagreementRate: 0,
  wrongFocusRate: 0,
  ownerCorrectionRate: 0,
  independentProofRate: 1,
  serviceAuthFailure: false,
}

describe('evaluateRollbackThresholds', () => {
  it('clean metrics → no rollback', () => {
    expect(evaluateRollbackThresholds(CLEAN)).toEqual([])
  })

  it('any hard-invariant breach turns the class OFF', () => {
    for (const key of ['duplicateExternalEffects', 'unapprovedHighImpactEffects', 'crossAccountEffects', 'secretLeaks'] as const) {
      const actions = evaluateRollbackThresholds({ ...CLEAN, [key]: 1 })
      expect(actions.some((a) => a.scope === 'class_off'), key).toBe(true)
    }
  })

  it('unknown effect → effect class off until reconciled', () => {
    const a = evaluateRollbackThresholds({ ...CLEAN, unknownEffects: 1 })
    expect(a.some((x) => x.scope === 'effect_class_off_until_reconciled')).toBe(true)
  })

  it('quality regressions return to the prior rung at the exact thresholds', () => {
    expect(evaluateRollbackThresholds({ ...CLEAN, graphDisagreementRate: 0.021 }).some((a) => a.scope === 'return_prior_rung')).toBe(true)
    expect(evaluateRollbackThresholds({ ...CLEAN, graphDisagreementRate: 0.02 }).some((a) => a.scope === 'return_prior_rung')).toBe(false)
    expect(evaluateRollbackThresholds({ ...CLEAN, wrongFocusRate: 0.011 }).some((a) => a.scope === 'return_prior_rung')).toBe(true)
    expect(evaluateRollbackThresholds({ ...CLEAN, ownerCorrectionRate: 0.021 }).some((a) => a.scope === 'return_prior_rung')).toBe(true)
  })

  it('proof below 99% blocks promotion', () => {
    expect(evaluateRollbackThresholds({ ...CLEAN, independentProofRate: 0.98 }).some((a) => a.scope === 'no_promotion')).toBe(true)
    expect(evaluateRollbackThresholds({ ...CLEAN, independentProofRate: 0.99 }).some((a) => a.scope === 'no_promotion')).toBe(false)
  })

  it('service auth failure pauses the service', () => {
    expect(evaluateRollbackThresholds({ ...CLEAN, serviceAuthFailure: true }).some((a) => a.scope === 'service_paused')).toBe(true)
  })
})

describe('evaluateLegacyRetirementGate — legacy stays until proven safe', () => {
  it('needs 30 clean days + no rollback + owner approval', () => {
    expect(evaluateLegacyRetirementGate({ consecutiveDaysAtFinalStage: 30, rollbackSignalInWindow: false, ownerApproved: true }).eligible).toBe(true)
    expect(evaluateLegacyRetirementGate({ consecutiveDaysAtFinalStage: 29, rollbackSignalInWindow: false, ownerApproved: true }).eligible).toBe(false)
    expect(evaluateLegacyRetirementGate({ consecutiveDaysAtFinalStage: 40, rollbackSignalInWindow: true, ownerApproved: true }).eligible).toBe(false)
    expect(evaluateLegacyRetirementGate({ consecutiveDaysAtFinalStage: 40, rollbackSignalInWindow: false, ownerApproved: false }).eligible).toBe(false)
  })
})

describe('computeOwnerBenefitScorecard — never invents ROI', () => {
  it('produces a well-formed card and keeps business outcome unknown', async () => {
    const card = await computeOwnerBenefitScorecard(7)
    expect(card.windowDays).toBe(7)
    expect(card.businessOutcome).toBe('unknown')
    expect(typeof card.generatedAt).toBe('string')
    expect(Array.isArray(card.rollbackActions)).toBe(true)
    expect(Array.isArray(card.topBlockers)).toBe(true)
  })
})
