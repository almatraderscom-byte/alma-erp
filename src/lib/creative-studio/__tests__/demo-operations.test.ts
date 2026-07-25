import { describe, expect, it } from 'vitest'
import {
  applyDemoPlan,
  DEMO_PLAN_FINGERPRINT,
  INITIAL_DEMO_STATE,
  rollbackDemoPlan,
} from '@/lib/creative-studio/demo-operations'

describe('enterprise Studio demo operation contract', () => {
  it('requires the exact owner-reviewed plan fingerprint', () => {
    expect(() => applyDemoPlan(INITIAL_DEMO_STATE, 'stale-plan')).toThrow(
      'plan_approval_required',
    )
  })

  it('applies only local zero-cost edits', () => {
    const result = applyDemoPlan(INITIAL_DEMO_STATE, DEMO_PLAN_FINGERPRINT)

    expect(result.applied).toHaveLength(3)
    expect(result.applied.every((operation) => (
      operation.effect === 'local' && operation.estimatedCostBdt === 0
    ))).toBe(true)
    expect(result.blocked.map((operation) => operation.effect)).toEqual([
      'paid_generation',
      'external_publish',
    ])
    expect(result.state.version).toBe(13)
    expect(result.state.captionStartSec).toBe(1.2)
    expect(result.state.musicVolume).toBe(12)
  })

  it('creates a new version when rolling back to the captured state', () => {
    const applied = applyDemoPlan(INITIAL_DEMO_STATE, DEMO_PLAN_FINGERPRINT)
    const rolledBack = rollbackDemoPlan(applied.state, INITIAL_DEMO_STATE)

    expect(rolledBack).toEqual({
      ...INITIAL_DEMO_STATE,
      version: 14,
    })
  })
})
