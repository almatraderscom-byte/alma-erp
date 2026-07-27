/**
 * SK-8 — the enterprise gap the 2026-07-27 research review named: which version
 * of a skill ran, who approved it, and how to take it back.
 *
 * The rules live in a pure module so they can be held down here rather than
 * discovered on his screen — which is exactly how the SK-4 allowlist holes were
 * found late.
 */
import { describe, expect, it } from 'vitest'
import path from 'path'
import {
  approvalState,
  computeSkillHash,
  grant,
  heldBackReason,
  mayRun,
  revoke,
  type SkillApprovalLedger,
} from '@/agent/lib/skill-engine/provenance'

const AT = '2026-07-27T00:00:00.000Z'
const skill = { name: 'seo-fixing-own-site', version: '1.0.0', hash: 'abc123' }

describe('approval state — the hash decides, not the version string', () => {
  it('a skill nobody approved is unapproved', () => {
    expect(approvalState(skill, {})).toBe('unapproved')
  })

  it('approved content reads as approved', () => {
    const ledger = grant({}, { ...skill, approvedBy: 'owner', at: AT })
    expect(approvalState(skill, ledger)).toBe('approved')
  })

  it('EDITED WITHOUT A VERSION BUMP is caught — the case that would go unnoticed', () => {
    const ledger = grant({}, { ...skill, approvedBy: 'owner', at: AT })
    const edited = { ...skill, hash: 'different' }
    expect(approvalState(edited, ledger)).toBe('changed')
  })

  it('a version bumped without a new approval is also `changed`', () => {
    const ledger = grant({}, { ...skill, approvedBy: 'owner', at: AT })
    expect(approvalState({ ...skill, version: '2.0.0', hash: 'newhash' }, ledger)).toBe('changed')
  })

  it('revoked beats everything, even matching content', () => {
    const approved = grant({}, { ...skill, approvedBy: 'owner', at: AT })
    const ledger = revoke(approved, { name: skill.name, at: AT, reason: 'wrote bad copy' })
    expect(approvalState(skill, ledger)).toBe('revoked')
  })
})

describe('the gate', () => {
  it('OFF observes only — nothing is refused while the ledger is being filled', () => {
    for (const s of ['approved', 'changed', 'revoked', 'unapproved'] as const) {
      expect(mayRun(s, false)).toBe(true)
    }
  })

  it('ON lets only approved content run', () => {
    expect(mayRun('approved', true)).toBe(true)
    expect(mayRun('changed', true)).toBe(false)
    expect(mayRun('revoked', true)).toBe(false)
    expect(mayRun('unapproved', true)).toBe(false)
  })
})

describe('rollback keeps the trail', () => {
  it('revoking preserves who approved it and why it was pulled', () => {
    const approved = grant({}, { ...skill, approvedBy: 'owner', at: AT, note: 'first release' })
    const ledger = revoke(approved, { name: skill.name, at: '2026-07-28T00:00:00.000Z', reason: 'bad copy' })
    const rec = ledger[skill.name]
    expect(rec.approvedBy).toBe('owner')
    expect(rec.note).toBe('first release')
    expect(rec.revokedReason).toBe('bad copy')
    expect(rec.revokedAt).toBe('2026-07-28T00:00:00.000Z')
  })

  it('re-approving clears the revocation', () => {
    const revoked = revoke(grant({}, { ...skill, approvedBy: 'owner', at: AT }), { name: skill.name, at: AT })
    const again = grant(revoked, { ...skill, hash: 'v2hash', approvedBy: 'owner', at: AT })
    expect(again[skill.name].revokedAt).toBeUndefined()
    expect(approvalState({ ...skill, hash: 'v2hash' }, again)).toBe('approved')
  })

  it('revoking a skill nobody approved changes nothing', () => {
    const ledger: SkillApprovalLedger = {}
    expect(revoke(ledger, { name: 'nope', at: AT })).toBe(ledger)
  })
})

describe('the hash is computed over the real files', () => {
  const dir = (n: string) => path.join(process.cwd(), 'src', 'agent', 'skills', n)

  it('is stable for the same package', async () => {
    const a = await computeSkillHash(dir('seo-fixing-own-site'))
    const b = await computeSkillHash(dir('seo-fixing-own-site'))
    expect(a).toBe(b)
    expect(a).toMatch(/^[a-f0-9]{64}$/)
  })

  it('differs between packages', async () => {
    const a = await computeSkillHash(dir('seo-fixing-own-site'))
    const b = await computeSkillHash(dir('seo-auditing-own-site'))
    expect(a).not.toBe(b)
  })

  it('a missing directory hashes rather than throwing', async () => {
    await expect(computeSkillHash(dir('does-not-exist'))).resolves.toMatch(/^[a-f0-9]{64}$/)
  })
})

describe('when a skill is held back, Boss is told why', () => {
  it('each state has its own sentence, and none of them is silence', () => {
    for (const s of ['changed', 'revoked', 'unapproved'] as const) {
      const msg = heldBackReason('seo-fixing-own-site', s)
      expect(msg.length).toBeGreaterThan(20)
      expect(msg).toContain('seo-fixing-own-site')
    }
    expect(heldBackReason('x', 'approved')).toBe('')
  })
})
