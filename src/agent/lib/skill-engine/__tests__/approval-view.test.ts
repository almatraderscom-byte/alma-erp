/**
 * SK-8 item 1 — the read model behind the owner's approval screen.
 *
 * The thing worth holding down here is the distinction the screen exists to
 * make: APPROVED is not the same as RUNS. A draft skill can be approved and
 * still never be offered, and `alma-base` can never be selected at all. A green
 * tick next to either would be the same class of lie SK-8 was built to stop.
 */
import { describe, expect, it } from 'vitest'
import { buildApprovalView, type SkillApprovalInput } from '@/agent/lib/skill-engine/approval-view'
import { grant, revoke, type SkillApprovalLedger } from '@/agent/lib/skill-engine/provenance'

const AT = '2026-07-27T00:00:00.000Z'

const live: SkillApprovalInput = {
  name: 'seo-fixing-own-site',
  version: '1.0.0',
  status: 'active',
  implicit: true,
  isolation: 'subagent',
  hash: 'aaaaaaaaaaaabbbb',
}
const draft: SkillApprovalInput = { ...live, name: 'alma-marketing', status: 'draft', isolation: 'inline', hash: 'cccc' }
const base: SkillApprovalInput = { ...live, name: 'alma-base', implicit: false, isolation: 'inline', hash: 'dddd' }

const approvedLedger = (s: SkillApprovalInput): SkillApprovalLedger =>
  grant({}, { name: s.name, version: s.version, hash: s.hash, approvedBy: 'owner', at: AT })

describe('what would actually run', () => {
  it('an approved active skill runs when the engine is on', () => {
    const v = buildApprovalView([live], approvedLedger(live), { gateOn: true, engineEnabled: true })
    expect(v.rows[0].state).toBe('approved')
    expect(v.rows[0].wouldRun).toBe(true)
    expect(v.rows[0].blockedBy).toBeNull()
  })

  it('nothing runs while the engine is off, however well approved', () => {
    const v = buildApprovalView([live], approvedLedger(live), { gateOn: true, engineEnabled: false })
    expect(v.rows[0].wouldRun).toBe(false)
  })

  it('a DRAFT is reported as draft, not as an approval problem', () => {
    // Sending him to approve a draft would change nothing — 15 of the 16
    // originals are draft, and that is the reason they never did anything.
    const v = buildApprovalView([draft], {}, { gateOn: true, engineEnabled: true })
    expect(v.rows[0].blockedBy).toBe('draft')
  })

  it('an approved draft still does not run', () => {
    const v = buildApprovalView([draft], approvedLedger(draft), { gateOn: true, engineEnabled: true })
    expect(v.rows[0].state).toBe('approved')
    expect(v.rows[0].wouldRun).toBe(false)
  })

  it('implicit:false is never-auto, not unapproved', () => {
    const v = buildApprovalView([base], approvedLedger(base), { gateOn: true, engineEnabled: true })
    expect(v.rows[0].blockedBy).toBe('never-auto')
  })

  it('with the gate OFF an unapproved skill still runs — that is why it is off', () => {
    const v = buildApprovalView([live], {}, { gateOn: false, engineEnabled: true })
    expect(v.rows[0].state).toBe('unapproved')
    expect(v.rows[0].wouldRun).toBe(true)
  })

  it('with the gate ON the same skill is blocked by approval', () => {
    const v = buildApprovalView([live], {}, { gateOn: true, engineEnabled: true })
    expect(v.rows[0].blockedBy).toBe('approval')
    expect(v.rows[0].wouldRun).toBe(false)
  })

  it('a revoked skill stops running', () => {
    const ledger = revoke(approvedLedger(live), { name: live.name, at: AT, reason: 'incident' })
    const v = buildApprovalView([live], ledger, { gateOn: true, engineEnabled: true })
    expect(v.rows[0].state).toBe('revoked')
    expect(v.rows[0].wouldRun).toBe(false)
  })

  it('edited-after-approval reads as changed', () => {
    const ledger = approvedLedger(live)
    const v = buildApprovalView([{ ...live, hash: 'edited' }], ledger, { gateOn: true, engineEnabled: true })
    expect(v.rows[0].state).toBe('changed')
  })
})

describe('a skill is only as approved as the base it inherits', () => {
  // The blind spot found 2026-07-27 while filling the ledger: `alma-base` is
  // never SELECTED, so the approval check never looked at it — and it is the
  // file that carries the ALMA invariants.
  const child: SkillApprovalInput = { ...live, extends: 'alma-base' }

  it('an approved skill with an UNapproved base does not run', () => {
    const v = buildApprovalView([child, base], approvedLedger(child), { gateOn: true, engineEnabled: true })
    const row = v.rows.find((r) => r.name === child.name)!
    expect(row.state).toBe('approved')
    expect(row.effectiveState).toBe('unapproved')
    expect(row.blockedBy).toBe('base')
    expect(row.blockedByName).toBe('alma-base')
    expect(row.wouldRun).toBe(false)
  })

  it('editing the base after approval stops every skill that inherits it', () => {
    const ledger = { ...approvedLedger(child), ...approvedLedger(base) }
    const v = buildApprovalView([child, { ...base, hash: 'base-edited' }], ledger, { gateOn: true, engineEnabled: true })
    const row = v.rows.find((r) => r.name === child.name)!
    expect(row.effectiveState).toBe('changed')
    expect(row.blockedBy).toBe('base')
  })

  it('both approved → it runs', () => {
    const ledger = { ...approvedLedger(child), ...approvedLedger(base) }
    const v = buildApprovalView([child, base], ledger, { gateOn: true, engineEnabled: true })
    expect(v.rows.find((r) => r.name === child.name)!.wouldRun).toBe(true)
  })

  it('an unapproved base counts in needsApproval, so the number is not a surprise', () => {
    const v = buildApprovalView([child, base], approvedLedger(child), { gateOn: false, engineEnabled: true })
    expect(v.summary.needsApproval).toBe(1)
  })
})

describe('the summary is the number he decides on', () => {
  it('needsApproval counts only skills the gate would actually stop', () => {
    // draft and implicit:false are unapproved too, but turning the gate on does
    // not change anything for them — counting them would overstate the damage.
    const v = buildApprovalView([live, draft, base], {}, { gateOn: false, engineEnabled: true })
    expect(v.summary.needsApproval).toBe(1)
    expect(v.summary.total).toBe(3)
  })

  it('selectable skills sort first and the order is stable', () => {
    const v = buildApprovalView([draft, base, live], {}, { gateOn: false, engineEnabled: true })
    expect(v.rows.map((r) => r.name)).toEqual(['alma-base', 'seo-fixing-own-site', 'alma-marketing'])
  })

  it('hashShort is short enough to read and long enough to tell two builds apart', () => {
    const v = buildApprovalView([live], {}, { gateOn: false, engineEnabled: true })
    expect(v.rows[0].hashShort).toBe(live.hash.slice(0, 12))
  })
})
