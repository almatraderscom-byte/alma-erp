import { describe, it, expect } from 'vitest'
import {
  decideAutonomy,
  type AutonomyPolicy,
  type ActionDescriptor,
} from '@/agent/lib/autonomy-policy'

// A permissive baseline policy so each test can flip exactly the knob it cares about.
function policy(overrides: Partial<AutonomyPolicy> = {}): AutonomyPolicy {
  return {
    enabled: true,
    moneyCapTaka: 100,
    confidenceMin: 0.8,
    categoryModes: {
      cs_reply: 'auto',
      order_confirm: 'auto',
      order_followup: 'auto',
      reorder: 'auto',
      finance: 'auto',
      marketing: 'auto',
      staff_task: 'auto',
      other: 'auto',
    },
    ...overrides,
  }
}

function action(overrides: Partial<ActionDescriptor> = {}): ActionDescriptor {
  return { category: 'cs_reply', reversible: true, ...overrides }
}

describe('decideAutonomy — master kill-switch', () => {
  it('forces ask on EVERYTHING when autonomy is disabled', () => {
    const d = decideAutonomy(action({ category: 'cs_reply', reversible: true }), policy({ enabled: false }))
    expect(d.mode).toBe('ask')
  })
})

describe('decideAutonomy — money guards', () => {
  it('always asks for irreversible spend, regardless of cap', () => {
    const d = decideAutonomy(action({ moneyTaka: 1, reversible: false }), policy({ moneyCapTaka: 100000 }))
    expect(d.mode).toBe('ask')
    expect(d.riskTier).toBe('high')
  })

  it('asks when spend exceeds the cap', () => {
    const d = decideAutonomy(action({ moneyTaka: 500, reversible: true }), policy({ moneyCapTaka: 100 }))
    expect(d.mode).toBe('ask')
    expect(d.riskTier).toBe('high')
  })

  it('allows a reversible spend within the cap to follow the category mode', () => {
    const d = decideAutonomy(action({ category: 'reorder', moneyTaka: 50, reversible: true }), policy({ moneyCapTaka: 100 }))
    expect(d.mode).toBe('auto')
  })
})

describe('decideAutonomy — category modes', () => {
  it('uses the per-category mode as the base decision', () => {
    const d = decideAutonomy(action({ category: 'marketing' }), policy({ categoryModes: { ...policy().categoryModes, marketing: 'propose' } }))
    expect(d.mode).toBe('propose')
  })
})

describe('decideAutonomy — confidence floor', () => {
  it('downgrades a shaky auto action to propose', () => {
    const d = decideAutonomy(action({ confidence: 0.5 }), policy({ confidenceMin: 0.8 }))
    expect(d.mode).toBe('propose')
  })

  it('downgrades a shaky propose action to ask', () => {
    const d = decideAutonomy(
      action({ category: 'marketing', confidence: 0.5 }),
      policy({ confidenceMin: 0.8, categoryModes: { ...policy().categoryModes, marketing: 'propose' } }),
    )
    expect(d.mode).toBe('ask')
  })

  it('leaves a confident action at its category mode', () => {
    const d = decideAutonomy(action({ confidence: 0.95 }), policy({ confidenceMin: 0.8 }))
    expect(d.mode).toBe('auto')
  })

  it('treats undefined confidence as fully confident', () => {
    const d = decideAutonomy(action({ confidence: undefined }), policy({ confidenceMin: 0.99 }))
    expect(d.mode).toBe('auto')
  })
})

describe('decideAutonomy — irreversible never silently auto-fires', () => {
  it('caps an irreversible non-money auto action down to propose', () => {
    const d = decideAutonomy(action({ reversible: false }), policy())
    expect(d.mode).toBe('propose')
  })
})

describe('decideAutonomy — reason + riskTier', () => {
  it('returns low risk only for auto, and a Bangla reason', () => {
    const d = decideAutonomy(action({ confidence: 0.95 }), policy())
    expect(d.mode).toBe('auto')
    expect(d.riskTier).toBe('low')
    expect(d.reason).toMatch(/[ঀ-৿]/) // contains Bangla characters
  })
})
