/**
 * SK-8 — a refusal nobody can see is indistinguishable from a bug.
 *
 * This is the exact shape of the failure found in production on 2026-07-27:
 * `seo-fixing-own-site` was approved at one content hash, its manifest and
 * SKILL.md were edited the next day, and the gate read `changed` and withheld it
 * — correctly. But `buildActiveSkills` returned the same "nothing here" shape it
 * returns when the engine is off, so no client could tell the difference, and
 * the engine looked switched on and idle for a full day.
 *
 * These pin the two properties that make the refusal legible: the caller learns
 * WHICH skill and WHICH state, and the ordinary paths keep saying nothing.
 */
import { describe, it, expect } from 'vitest'
import { approvalState, mayRun, heldBackReason } from '@/agent/lib/skill-engine/provenance'
import type { SkillApprovalLedger } from '@/agent/lib/skill-engine/provenance'

describe('the state that actually bit us', () => {
  const ledger: SkillApprovalLedger = {
    'seo-fixing-own-site': {
      version: '1.0.0',
      hash: 'hash-as-approved',
      approvedBy: 'owner',
      approvedAt: '2026-07-26T00:00:00.000Z',
    },
  }

  it('editing an approved skill makes it `changed`, not `approved`', () => {
    expect(
      approvalState({ name: 'seo-fixing-own-site', version: '1.0.0', hash: 'hash-after-edit' }, ledger),
    ).toBe('changed')
  })

  it('a version left untouched does not hide the edit', () => {
    // The trap: #627 added a tool to the manifest without bumping the version.
    const state = approvalState(
      { name: 'seo-fixing-own-site', version: '1.0.0', hash: 'hash-after-edit' },
      ledger,
    )
    expect(state).not.toBe('approved')
  })

  it('with the gate on, `changed` does not run', () => {
    expect(mayRun('changed', true)).toBe(false)
    expect(mayRun('changed', false)).toBe(true)
  })

  it('re-approving the content on disk brings it back', () => {
    const reapproved: SkillApprovalLedger = {
      'seo-fixing-own-site': { ...ledger['seo-fixing-own-site'], hash: 'hash-after-edit' },
    }
    expect(
      approvalState({ name: 'seo-fixing-own-site', version: '1.0.0', hash: 'hash-after-edit' }, reapproved),
    ).toBe('approved')
  })
})

describe('the owner-facing sentence', () => {
  it('names the skill and says it is waiting on a decision', () => {
    const line = heldBackReason('seo-fixing-own-site', 'changed')
    expect(line).toContain('seo-fixing-own-site')
    expect(line).toContain('বদলানো হয়েছে')
  })

  it('tells the three refusals apart', () => {
    const changed = heldBackReason('x', 'changed')
    const unapproved = heldBackReason('x', 'unapproved')
    const revoked = heldBackReason('x', 'revoked')
    expect(new Set([changed, unapproved, revoked]).size).toBe(3)
    // The lengths are how the live cause was identified from a probe that only
    // reported a character count — keep them distinct.
    expect(new Set([changed.length, unapproved.length, revoked.length]).size).toBe(3)
  })

  it('says nothing when the skill is fine', () => {
    expect(heldBackReason('x', 'approved')).toBe('')
  })
})
