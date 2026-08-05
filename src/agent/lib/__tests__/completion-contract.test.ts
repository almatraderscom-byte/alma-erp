import { describe, expect, it } from 'vitest'
import {
  advanceCompletionAttempt,
  completionContinuationNote,
  createCompletionContract,
  completionContractFromPlanProgress,
  decideCompletion,
  recordCompletionCriterion,
} from '@/agent/lib/completion-contract'

describe('deterministic completion contract', () => {
  it('does not accept model stopping or partial work as completion', () => {
    const contract = createCompletionContract({
      taskRef: 'task-1', taskKind: 'complex', workClass: 'deep', now: '2026-08-03T00:00:00.000Z',
    })
    const decision = decideCompletion(contract)
    expect(decision.action).toBe('continue')
    if (decision.action === 'continue') {
      expect(decision.missing).toHaveLength(4)
      expect(completionContinuationNote(decision)).toContain('do not close')
    }
  })

  it('requires evidence for every satisfied criterion', () => {
    const contract = createCompletionContract({ taskRef: 'mac-1', taskKind: 'mac', workClass: 'long_run' })
    expect(() => recordCompletionCriterion(contract, { id: 'before_proof', state: 'satisfied' }))
      .toThrow('completion_evidence_required')
  })

  it('completes only after all criteria carry evidence', () => {
    let contract = createCompletionContract({ taskRef: 'mac-1', taskKind: 'mac', workClass: 'long_run' })
    for (const criterion of contract.criteria) {
      contract = recordCompletionCriterion(contract, {
        id: criterion.id, state: 'satisfied', evidence: `receipt:${criterion.id}`,
      })
    }
    expect(decideCompletion(contract).action).toBe('complete')
  })

  it('turns an explicit blocker or exhausted recovery budget into a checkpoint', () => {
    let blocked = createCompletionContract({ taskRef: 'mac-2', taskKind: 'mac', workClass: 'deep' })
    blocked = recordCompletionCriterion(blocked, {
      id: 'postcondition', state: 'blocked', blocker: 'Mac offline',
    })
    expect(decideCompletion(blocked)).toMatchObject({ action: 'checkpoint', blocker: 'Mac offline' })

    let exhausted = createCompletionContract({ taskRef: 'task-2', taskKind: 'complex', workClass: 'deep' })
    for (let i = 0; i < exhausted.maxAttempts; i += 1) exhausted = advanceCompletionAttempt(exhausted)
    expect(decideCompletion(exhausted)).toMatchObject({
      action: 'checkpoint', blocker: 'completion_recovery_budget_exhausted',
    })
  })

  it('rebuilds truth from durable plan rows across continuation hops', () => {
    const partial = completionContractFromPlanProgress({
      planId: 'plan-1', goal: 'ship', workClass: 'long_run',
      rows: [
        { seq: 2, action: 'verify', status: 'pending' },
        { seq: 1, action: 'implement', status: 'done' },
      ],
    })!
    expect(partial.criteria.map((criterion) => criterion.id)).toEqual(['step_1', 'step_2'])
    expect(decideCompletion(partial).action).toBe('continue')

    const blocked = completionContractFromPlanProgress({
      planId: 'plan-1', goal: 'ship', workClass: 'long_run',
      rows: [{ seq: 1, action: 'implement', status: 'failed' }],
    })!
    expect(decideCompletion(blocked).action).toBe('checkpoint')
  })
})
