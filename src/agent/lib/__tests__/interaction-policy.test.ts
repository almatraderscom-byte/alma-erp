/**
 * Phase 36 — interaction state/policy/planner + commitment ledger contracts.
 */
import { describe, it, expect } from 'vitest'
import {
  deriveInteractionMode,
  deriveInteractionState,
  deriveEmotion,
  detectCorrection,
  detectCrisis,
} from '@/agent/lib/interaction-state'
import {
  policyForState,
  checkCommitmentLedger,
  violatesAddressContract,
  OWNER_ADDRESS,
  NON_DECEPTION_NOTE,
} from '@/agent/lib/interaction-policy'
import { planResponse, buildResponseDirective, openerFor } from '@/agent/lib/response-planner'

describe('mode ladder (deterministic, first hit wins)', () => {
  it('crisis beats everything', () => {
    expect(deriveInteractionMode({ text: 'ar parchi na, bachte iccha korche na', headTier: 'personal' })).toBe('crisis_safety')
  })
  it('confirmed listen tier → personal_listen', () => {
    expect(deriveInteractionMode({ text: 'mon ta valo nei', headTier: 'personal' })).toBe('personal_listen')
  })
  it('teaching flag → teaching', () => {
    expect(deriveInteractionMode({ text: 'ekhon theke invoice e VAT dhorbe', teaching: true })).toBe('teaching')
  })
  it('decision/coaching asks', () => {
    expect(deriveInteractionMode({ text: 'notun dokan nibo kina — ki kora uchit?' })).toBe('decision_support')
    expect(deriveInteractionMode({ text: 'kivabe ad copy likha shikhbo? guide koro' })).toBe('coaching')
  })
  it('short status query → concise_status', () => {
    expect(deriveInteractionMode({ text: 'ki obostha oi kajer?', statusQuery: true })).toBe('concise_status')
  })
  it('default → work', () => {
    expect(deriveInteractionMode({ text: 'notun panjabi r post banao' })).toBe('work')
  })
})

describe('emotion + correction + repair', () => {
  it('reads the four emotion families', () => {
    expect(deriveEmotion('mon kharap')).toBe('low')
    expect(deriveEmotion('onek tension hocche')).toBe('anxious')
    expect(deriveEmotion('dhur, faltu kaj korecho')).toBe('angry')
    expect(deriveEmotion('darun hoyeche, dhonnobad')).toBe('positive')
    expect(deriveEmotion('stock koto?')).toBe('neutral')
  })
  it('detects owner corrections and flags repair', () => {
    expect(detectCorrection('na na eta na, ageর টা')).toBe(true)
    expect(detectCorrection('vul korecho, amount 700 chilo')).toBe(true)
    expect(detectCorrection('thik ache, koro')).toBe(false)
    const s = deriveInteractionState({ text: 'vul korecho, abar dekho' })
    expect(s.repairNeeded).toBe(true)
  })
  it('crisis net stays narrow', () => {
    expect(detectCrisis('আজ বিক্রি খুব খারাপ')).toBe(false)
  })
})

describe('policy contracts', () => {
  it('listen + crisis strip tools and forbid work pivot', () => {
    for (const mode of ['personal_listen', 'crisis_safety'] as const) {
      const p = policyForState({ mode, emotion: 'low', correction: false, repairNeeded: false, detail: 'normal' })
      expect(p.allowTools).toBe(false)
      expect(p.allowWorkPivot).toBe(false)
      expect(p.mustAcknowledgeFeeling).toBe(true)
    }
  })
  it('only work mode may pivot to in-flight business', () => {
    const modes = ['personal_listen', 'crisis_safety', 'coaching', 'decision_support', 'concise_status', 'teaching'] as const
    for (const mode of modes) {
      const p = policyForState({ mode, emotion: 'neutral', correction: false, repairNeeded: false, detail: 'normal' })
      expect(p.allowWorkPivot, mode).toBe(false)
    }
    expect(policyForState({ mode: 'work', emotion: 'neutral', correction: false, repairNeeded: false, detail: 'normal' }).allowWorkPivot).toBe(true)
  })
  it('a low/anxious WORK message still gets a feeling acknowledgement', () => {
    const p = policyForState({ mode: 'work', emotion: 'anxious', correction: false, repairNeeded: false, detail: 'normal' })
    expect(p.mustAcknowledgeFeeling).toBe(true)
  })
})

describe('commitment ledger', () => {
  it('an unbacked future promise fails the ledger', () => {
    const v = checkCommitmentLedger('Boss, kal shokal e report ta banabo।', {})
    expect(v.promised).toBe(true)
    expect(v.ok).toBe(false)
  })
  it('the same promise backed by durable state passes', () => {
    expect(checkCommitmentLedger('Boss, report ta banabo — task e rakhlam।', { openTaskTracked: true }).ok).toBe(true)
    expect(checkCommitmentLedger('করে দেবো Boss।', { cardStaged: true }).ok).toBe(true)
    expect(checkCommitmentLedger('dekhe janabo Boss', { reminderSet: true }).ok).toBe(true)
  })
  it('already-done wording is not a promise', () => {
    expect(checkCommitmentLedger('Boss, কাজটা করে দিয়েছি — হয়ে গেছে।', {}).promised).toBe(false)
  })
  it('a plain answer with no promise passes with no evidence', () => {
    expect(checkCommitmentLedger('Boss, আজ বিক্রি ৳12,400।', {}).ok).toBe(true)
  })
})

describe('address + non-deception contracts', () => {
  it('single owner address is Boss; banned addresses are caught', () => {
    expect(OWNER_ADDRESS).toBe('Boss')
    expect(violatesAddressContract('জি Sir, করে দিচ্ছি')).toBe(true)
    expect(violatesAddressContract('জি স্যার!')).toBe(true)
    expect(violatesAddressContract('জি Boss, করে দিচ্ছি — কার্ড দিলাম।')).toBe(false)
  })
  it('the system prompt carries the Boss hard rule and the non-deception line', async () => {
    const { buildSystemPromptBlocks } = await import('@/agent/lib/system-prompt')
    const { stable } = buildSystemPromptBlocks({ personalMode: false })
    const text = stable.map((b) => b.text).join('\n')
    expect(text).toContain('সম্বোধন (HARD RULE')
    expect(text).toContain('non-deception')
    expect(text).toContain('AI অ্যাসিস্ট্যান্ট')
    expect(NON_DECEPTION_NOTE).toContain('AI অ্যাসিস্ট্যান্ট')
  })
})

describe('response planner', () => {
  const state = { mode: 'work' as const, emotion: 'low' as const, correction: true, repairNeeded: true, detail: 'normal' as const }
  it('orders repair → acknowledge → answer → evidence → commitment; omits the unnecessary', () => {
    const policy = policyForState(state)
    const plan = planResponse(state, policy, { turnCount: 7, hasEvidence: true, willCommit: true })
    expect(plan.sections).toEqual(['repair', 'acknowledge', 'answer', 'evidence', 'commitment'])
    const bare = planResponse(
      { ...state, correction: false, repairNeeded: false, emotion: 'neutral' },
      policyForState({ ...state, correction: false, repairNeeded: false, emotion: 'neutral' }),
      { turnCount: 7, hasEvidence: false, willCommit: false },
    )
    expect(bare.sections).toEqual(['answer'])
  })
  it('anti-repetition rotates openers deterministically — no randomness, no drift', () => {
    const policy = policyForState({ ...state, repairNeeded: false, correction: false, emotion: 'neutral' })
    const a = planResponse(state, policy, { turnCount: 4, hasEvidence: false, willCommit: false })
    const b = planResponse(state, policy, { turnCount: 5, hasEvidence: false, willCommit: false })
    const a2 = planResponse(state, policy, { turnCount: 4, hasEvidence: false, willCommit: false })
    expect(openerFor(a)).not.toEqual(openerFor(b))
    expect(openerFor(a)).toEqual(openerFor(a2))
  })
  it('the directive carries repair, feeling, no-pivot, uncertainty and ledger rules', () => {
    const st = { mode: 'personal_listen' as const, emotion: 'low' as const, correction: false, repairNeeded: false, detail: 'normal' as const }
    const pol = policyForState(st)
    const d = buildResponseDirective(st, pol, planResponse(st, pol, { turnCount: 1, hasEvidence: false, willCommit: false }))
    expect(d).toContain('INTERACTION CONTRACT')
    expect(d).toContain('অনুভূতিটা স্বীকার')
    expect(d).toContain('নিজে থেকে ব্যবসার চলমান কাজ টেনে আনবে না')
    expect(d).toContain('durable কমিটমেন্ট')
    expect(d).toContain('অনুমানকে তথ্যের মতো বলা নিষেধ')
  })
})
