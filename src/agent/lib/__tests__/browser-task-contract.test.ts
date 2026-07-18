import { describe, it, expect } from 'vitest'
import {
  validateContract,
  checkStepAgainstContract,
  domainInScope,
  domainOf,
  ALWAYS_HANDOFF_ACTIONS,
  type BrowserTaskContract,
} from '@/agent/lib/browser/success-criteria'

/**
 * Phase 67 — every browser task declares its scope/success/prohibited/handoff
 * BEFORE execution, and each step is checked against it. These lock the
 * deterministic safety rails: no cross-domain, no prohibited action, no write
 * under a read scope, and mandatory owner handoff for password/MFA/payment/etc.
 */

const CONTRACT: BrowserTaskContract = {
  targetDomains: ['facebook.com'],
  scope: 'write',
  criteria: [{ kind: 'url_matches', pattern: 'facebook\\.com/.*posts' }],
  prohibitedActions: ['delete_page', 'change_admin'],
  ownerHandoffTriggers: ['boost_post'],
}

describe('domain scope helpers', () => {
  it('normalizes hosts and matches subdomains only within the base', () => {
    expect(domainOf('https://www.facebook.com/some/path')).toBe('facebook.com')
    expect(domainInScope('business.facebook.com', ['facebook.com'])).toBe(true)
    expect(domainInScope('evil-facebook.com', ['facebook.com'])).toBe(false)
    expect(domainInScope('google.com', ['facebook.com'])).toBe(false)
  })
})

describe('validateContract — declared before execution', () => {
  it('requires domains, a scope, and at least one success criterion', () => {
    expect(validateContract(CONTRACT).ok).toBe(true)
    expect(validateContract(null).ok).toBe(false)
    expect(validateContract({ ...CONTRACT, targetDomains: [] }).ok).toBe(false)
    expect(validateContract({ ...CONTRACT, criteria: [] }).ok).toBe(false)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(validateContract({ ...CONTRACT, scope: 'delete' as any }).ok).toBe(false)
  })
})

describe('checkStepAgainstContract — per-step enforcement', () => {
  it('allows an in-scope, permitted write step', () => {
    const d = checkStepAgainstContract(CONTRACT, { domain: 'facebook.com', action: 'click_publish', isWrite: true })
    expect(d.allowed).toBe(true)
    expect(d.requiresHandoff).toBe(false)
  })

  it('blocks cross-domain navigation', () => {
    const d = checkStepAgainstContract(CONTRACT, { domain: 'google.com', action: 'open' })
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/cross-domain/)
  })

  it('blocks a task-prohibited action', () => {
    const d = checkStepAgainstContract(CONTRACT, { domain: 'facebook.com', action: 'delete_page', isWrite: true })
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/prohibited/)
  })

  it('blocks a write under a read-only scope', () => {
    const d = checkStepAgainstContract({ ...CONTRACT, scope: 'read' }, { domain: 'facebook.com', action: 'click_publish', isWrite: true })
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/read-only/)
  })

  it('always hands off password/MFA/payment/final_submit regardless of task', () => {
    for (const action of ALWAYS_HANDOFF_ACTIONS) {
      const d = checkStepAgainstContract(CONTRACT, { domain: 'facebook.com', action })
      expect(d.allowed, action).toBe(false)
      expect(d.requiresHandoff, action).toBe(true)
    }
  })

  it('hands off task-specific triggers too', () => {
    const d = checkStepAgainstContract(CONTRACT, { domain: 'facebook.com', action: 'boost_post' })
    expect(d.requiresHandoff).toBe(true)
  })
})
