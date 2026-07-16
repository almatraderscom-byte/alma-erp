import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/prisma', () => ({ prisma: {} }))

import {
  applyTransition,
  canTransition,
  validateReleasePlan,
  type SeoReleasePlan,
} from '@/agent/lib/seo/release-graph'

const change = (over = {}) => ({
  description: 'add Product JSON-LD to product template',
  affectedUrls: ['https://almalifestyle.com/p/panjabi-set'],
  evidence: 'seo_technical_audit: missing_structured_data on 12/14 product pages',
  validation: 'Rich Results Test + GSC search-appearance over 4 weeks',
  rollback: 'revert the template commit',
  ...over,
})

const plan = (over: Partial<SeoReleasePlan> = {}): SeoReleasePlan => ({
  id: 'rel-1',
  title: 'Product schema rollout',
  changes: [change()],
  status: 'draft',
  ...over,
})

describe('validateReleasePlan', () => {
  it('complete plan passes', () => {
    expect(validateReleasePlan(plan())).toEqual({ ok: true, errors: [] })
  })

  it('missing evidence / validation / rollback / urls each named', () => {
    const v = validateReleasePlan({
      title: 'x',
      changes: [{ description: 'd', affectedUrls: [], evidence: '', validation: '', rollback: '' }],
    })
    expect(v.ok).toBe(false)
    expect(v.errors.join()).toContain('affectedUrls')
    expect(v.errors.join()).toContain('evidence')
    expect(v.errors.join()).toContain('validation')
    expect(v.errors.join()).toContain('rollback')
  })

  it('ranking guarantees are rejected outright', () => {
    const v = validateReleasePlan(plan({ changes: [change({ description: 'we guarantee #1 rank on Google' })] }))
    expect(v.ok).toBe(false)
    expect(v.errors.join()).toContain('ranking guarantee')
  })
})

describe('release state machine', () => {
  it('legal path: draft→approved→preview_verified→released→rolled_back', () => {
    expect(canTransition('draft', 'approved')).toBe(true)
    expect(canTransition('approved', 'preview_verified')).toBe(true)
    expect(canTransition('preview_verified', 'released')).toBe(true)
    expect(canTransition('released', 'rolled_back')).toBe(true)
  })

  it('illegal jumps are blocked (draft→released, approved→released)', () => {
    expect(canTransition('draft', 'released')).toBe(false)
    expect(canTransition('approved', 'released')).toBe(false)
    const r = applyTransition(plan(), 'released', 'owner')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('illegal')
  })

  it('THE rule: only the owner releases — the agent can never deploy production', () => {
    const ready = plan({ status: 'preview_verified' })
    const agentTry = applyTransition(ready, 'released', 'agent')
    expect(agentTry.ok).toBe(false)
    expect(agentTry.error).toContain('OWNER')
    const ownerDo = applyTransition(ready, 'released', 'owner')
    expect(ownerDo.ok).toBe(true)
    expect(ownerDo.status).toBe('released')
  })

  it('approval revalidates the plan — an invalid plan cannot be approved', () => {
    const bad = plan({ changes: [change({ evidence: '' })] })
    const r = applyTransition(bad, 'approved', 'owner')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('evidence')
  })

  it('rolled_back can restart the loop as a new draft', () => {
    expect(applyTransition(plan({ status: 'rolled_back' }), 'draft', 'agent').ok).toBe(true)
  })
})
