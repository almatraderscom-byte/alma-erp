/**
 * Phase 57 exit gates as tests:
 *   • no global "auto everything" switch — one class, one rung, evidence-gated
 *   • R3/R4 classes are capped below auto forever
 *   • revoking/pausing takes effect before the next decision
 *   • automatic rollback on failures; evidence resets on any change
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  demoteTaskClass,
  effectiveStage,
  getRollout,
  LADDER_STAGES,
  listRollouts,
  maxStageForTier,
  promoteTaskClass,
  recordRolloutOutcome,
} from '@/agent/lib/autonomy-rollout'
import {
  DEFAULT_READINESS_TARGETS,
  evaluateReadiness,
  EMPTY_EVIDENCE,
  getReadinessEvidence,
  recordReadinessEvidence,
  resetReadinessEvidence,
  type ReadinessKv,
} from '@/agent/lib/autonomy-readiness'
import * as rolloutModule from '@/agent/lib/autonomy-rollout'
import { TASK_FAMILIES } from '@/agent/lib/autonomy-task-catalog'

class FakeKv implements ReadinessKv {
  store = new Map<string, string>()
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null
  }
  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value)
  }
}

let kv: FakeKv
beforeEach(() => {
  kv = new FakeKv()
})

/** Feed enough clean evidence to clear the default readiness gate. */
async function feedPassingEvidence(taskClass: string): Promise<void> {
  await recordReadinessEvidence(
    taskClass,
    {
      samples: 30,
      correct: 30,
      recoveries: 10,
      recoveryOpportunities: 10,
      proofs: 30,
      proofOpportunities: 30,
      compensationTested: true,
    },
    kv,
  )
}

describe('readiness gate', () => {
  it('empty evidence is never ready, with owner-readable blockers', () => {
    const verdict = evaluateReadiness(EMPTY_EVIDENCE)
    expect(verdict.ready).toBe(false)
    expect(verdict.blockers.some((b) => b.includes('নমুনা'))).toBe(true)
  })

  it('one critical guard failure blocks promotion regardless of volume', () => {
    const verdict = evaluateReadiness({ ...EMPTY_EVIDENCE, samples: 500, correct: 500, proofs: 500, proofOpportunities: 500, recoveries: 1, recoveryOpportunities: 1, compensationTested: true, criticalGuardFailures: 1 })
    expect(verdict.ready).toBe(false)
    expect(verdict.blockers.some((b) => b.includes('গুরুতর'))).toBe(true)
  })

  it('targets are met → ready', () => {
    const verdict = evaluateReadiness({ ...EMPTY_EVIDENCE, samples: 30, correct: 30, recoveries: 5, recoveryOpportunities: 5, proofs: 30, proofOpportunities: 30, compensationTested: true }, DEFAULT_READINESS_TARGETS)
    expect(verdict.ready).toBe(true)
  })
})

describe('ladder mechanics (exit gate: no auto-everything, one rung at a time)', () => {
  it('there is no batch-promotion API — the module only exposes per-class functions', () => {
    const exported = Object.keys(rolloutModule)
    expect(exported.some((name) => /all|every|global|bulk/i.test(name))).toBe(false)
  })

  it('promotion without an owner note is refused', async () => {
    const res = await promoteTaskClass('personal-records' in TASK_FAMILIES ? 'personal-records' : 'memory-notes', '', { kv })
    expect(res.ok).toBe(false)
  })

  it('off → shadow is free; every later rung demands evidence', async () => {
    const cls = 'memory-notes' // R1 family
    const toShadow = await promoteTaskClass(cls, 'Boss', { kv })
    expect(toShadow.ok).toBe(true)
    expect(toShadow.rollout.stage).toBe('shadow')

    const blocked = await promoteTaskClass(cls, 'Boss', { kv })
    expect(blocked.ok).toBe(false)
    expect(blocked.blockers.length).toBeGreaterThan(0)

    await feedPassingEvidence(cls)
    const toSuggest = await promoteTaskClass(cls, 'Boss', { kv })
    expect(toSuggest.ok).toBe(true)
    expect(toSuggest.rollout.stage).toBe('suggest')

    // Promotion consumed/reset the evidence — the next rung needs fresh proof.
    const blockedAgain = await promoteTaskClass(cls, 'Boss', { kv })
    expect(blockedAgain.ok).toBe(false)
  })

  it('rungs cannot be skipped — the walk is shadow → suggest → draft → auto_r1', async () => {
    const cls = 'memory-notes'
    const seen: string[] = ['off']
    for (let i = 0; i < 4; i += 1) {
      await feedPassingEvidence(cls)
      const res = await promoteTaskClass(cls, 'Boss', { kv })
      expect(res.ok).toBe(true)
      seen.push(res.rollout.stage)
    }
    expect(seen).toEqual(['off', 'shadow', 'suggest', 'draft', 'auto_r1'])
  })

  it('R1 families stop at auto_r1 (their ceiling)', async () => {
    const cls = 'memory-notes'
    for (let i = 0; i < 4; i += 1) {
      await feedPassingEvidence(cls)
      await promoteTaskClass(cls, 'Boss', { kv })
    }
    await feedPassingEvidence(cls)
    const over = await promoteTaskClass(cls, 'Boss', { kv })
    expect(over.ok).toBe(false)
    expect(over.blockers[0]).toContain('সর্বোচ্চ')
  })

  it('R3 families cap at draft; R4 caps at shadow — auto is unreachable forever', async () => {
    expect(maxStageForTier('R3')).toBe('draft')
    expect(maxStageForTier('R4')).toBe('shadow')

    const r3 = 'customer-messaging'
    // walk to draft
    for (let i = 0; i < 3; i += 1) {
      await feedPassingEvidence(r3)
      const res = await promoteTaskClass(r3, 'Boss', { kv })
      expect(res.ok).toBe(true)
    }
    expect((await getRollout(r3, kv)).stage).toBe('draft')
    await feedPassingEvidence(r3)
    const beyond = await promoteTaskClass(r3, 'Boss', { kv })
    expect(beyond.ok).toBe(false)
    expect(beyond.blockers[0]).toContain('R3/R4')

    const r4 = 'security-permissions'
    await feedPassingEvidence(r4)
    const s = await promoteTaskClass(r4, 'Boss', { kv })
    expect(s.ok).toBe(true)
    expect(s.rollout.stage).toBe('shadow')
    await feedPassingEvidence(r4)
    const beyond4 = await promoteTaskClass(r4, 'Boss', { kv })
    expect(beyond4.ok).toBe(false)
  })
})

describe('revoke/pause takes effect before the next decision', () => {
  it('demote to off is visible on the immediately following effectiveStage read', async () => {
    const cls = 'memory-notes'
    await promoteTaskClass(cls, 'Boss', { kv }) // shadow
    expect((await effectiveStage(cls, { kv })).stage).toBe('shadow')
    await demoteTaskClass(cls, 'off', 'owner pause', kv)
    expect((await effectiveStage(cls, { kv })).stage).toBe('off')
  })

  it('expired grants degrade to draft; quiet hours suppress auto', async () => {
    const cls = 'memory-notes'
    for (let i = 0; i < 4; i += 1) {
      await feedPassingEvidence(cls)
      await promoteTaskClass(cls, 'Boss', { kv })
    }
    // Force expiry in the stored scope.
    const rollout = await getRollout(cls, kv)
    await kv.set(`autonomy_rollout:${cls}`, JSON.stringify({ ...rollout, scope: { ...rollout.scope, expiresAt: '2020-01-01T00:00:00Z', quietHours: null } }))
    expect((await effectiveStage(cls, { kv })).stage).toBe('draft')

    // Quiet hours: 2am Dhaka inside default [23,7) window.
    await kv.set(`autonomy_rollout:${cls}`, JSON.stringify({ ...rollout, scope: { ...rollout.scope, expiresAt: null, quietHours: [23, 7] } }))
    const nightUtc = new Date('2026-07-17T20:00:00Z') // 02:00 Asia/Dhaka
    expect((await effectiveStage(cls, { now: nightUtc, kv })).stage).toBe('draft')
    const dayUtc = new Date('2026-07-17T06:00:00Z') // 12:00 Asia/Dhaka
    expect((await effectiveStage(cls, { now: dayUtc, kv })).stage).toBe('auto_r1')
  })
})

describe('automatic rollback', () => {
  it('failures over the threshold demote one rung and reset evidence', async () => {
    const cls = 'memory-notes'
    for (let i = 0; i < 4; i += 1) {
      await feedPassingEvidence(cls)
      await promoteTaskClass(cls, 'Boss', { kv })
    }
    expect((await getRollout(cls, kv)).stage).toBe('auto_r1')

    const first = await recordRolloutOutcome(cls, { ok: false }, { kv })
    expect(first.rolledBack).toBe(false) // threshold is 2 in the window
    const second = await recordRolloutOutcome(cls, { ok: false }, { kv })
    expect(second.rolledBack).toBe(true)
    expect(second.rollout.stage).toBe('draft')
    expect((await getReadinessEvidence(cls, kv)).samples).toBe(0) // evidence reset
  })

  it('a critical failure rolls back immediately', async () => {
    const cls = 'memory-notes'
    await promoteTaskClass(cls, 'Boss', { kv }) // shadow
    await feedPassingEvidence(cls)
    await promoteTaskClass(cls, 'Boss', { kv }) // suggest
    const res = await recordRolloutOutcome(cls, { ok: false, critical: true }, { kv })
    expect(res.rolledBack).toBe(true)
    expect(res.rollout.stage).toBe('shadow')
  })

  it('owner corrections count as failures', async () => {
    const cls = 'memory-notes'
    await promoteTaskClass(cls, 'Boss', { kv })
    const res = await recordRolloutOutcome(cls, { ok: true, ownerCorrected: true }, { kv })
    expect(res.rollout.recentFailures.length).toBe(1)
  })
})

describe('evidence reset on change + full ladder view', () => {
  it('resetReadinessEvidence wipes accumulated proof', async () => {
    await feedPassingEvidence('erp-reporting')
    expect((await getReadinessEvidence('erp-reporting', kv)).samples).toBe(30)
    await resetReadinessEvidence('erp-reporting', 'policy version bump', 'p57.2', kv)
    const fresh = await getReadinessEvidence('erp-reporting', kv)
    expect(fresh.samples).toBe(0)
    expect(fresh.version).toBe('p57.2')
  })

  it('listRollouts covers every task family with tier ceilings', async () => {
    const all = await listRollouts(kv)
    expect(all).toHaveLength(TASK_FAMILIES.length)
    for (const r of all) {
      expect(LADDER_STAGES).toContain(r.stage)
      expect(LADDER_STAGES).toContain(r.ceiling)
    }
    const r4 = all.find((r) => r.tier === 'R4')
    expect(r4?.ceiling).toBe('shadow')
  })

  it('unknown task classes cannot be promoted', async () => {
    const res = await promoteTaskClass('does-not-exist', 'Boss', { kv })
    expect(res.ok).toBe(false)
  })
})
