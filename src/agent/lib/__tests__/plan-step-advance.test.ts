import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  completionNeedsCheckpointRetry,
  continuationAfterPlanRowsSettlement,
  continuationAfterTrackerSettlement,
  pickFinalDeliveryStep,
  pickStepForTool,
  ownerBlockerFromToolResult,
  pendingActionTrackerState,
  prioritizePlanCreationForUntrackedRound,
  projectedDeliveryNeedsContinuation,
  shouldClearContinuationHops,
  projectFinalDeliveryForCompletion,
  unevaluatedPlanNeedsContinuation,
  type AdvanceableStep,
} from '@/agent/lib/plan-step-advance'

const step = (id: string, status: string, toolName?: string): AdvanceableStep =>
  ({ id, action: id, status, toolName: toolName ?? null })

describe('pickStepForTool', () => {
  it('runs make_plan before sibling work when the round had no tracker yet', () => {
    const calls = [{ name: 'get_orders' }, { name: 'make_plan' }, { name: 'get_approvals' }]
    expect(prioritizePlanCreationForUntrackedRound(calls, false).map((call) => call.name)).toEqual([
      'make_plan', 'get_orders', 'get_approvals',
    ])
    expect(prioritizePlanCreationForUntrackedRound(calls, true)).toBe(calls)
  })

  it('claims the step that names the tool, wherever it sits', () => {
    const steps = [step('s1', 'done', 'get_orders'), step('s2', 'pending', 'get_inventory_status')]
    expect(pickStepForTool(steps, 'get_inventory_status')?.id).toBe('s2')
  })

  it('claims the first open step when it names no tool of its own', () => {
    const steps = [step('s1', 'pending'), step('s2', 'pending', 'get_inventory_status')]
    expect(pickStepForTool(steps, 'get_orders')?.id).toBe('s1')
  })

  it('never ticks a step that names a different tool', () => {
    const steps = [step('s1', 'pending', 'get_inventory_status')]
    expect(pickStepForTool(steps, 'get_orders')).toBeNull()
  })

  it('never counts plan-control calls as doing the first work step', () => {
    const steps = [step('s1', 'pending')]
    expect(pickStepForTool(steps, 'make_plan')).toBeNull()
    expect(pickStepForTool(steps, 'execute_plan')).toBeNull()
    expect(pickStepForTool(steps, 'get_plan')).toBeNull()
  })

  it('returns null when every step is finished', () => {
    expect(pickStepForTool([step('s1', 'done', 'get_orders')], 'get_orders')).toBeNull()
  })

  it('re-claims a step already running (the same tool retried)', () => {
    const steps = [step('s1', 'running', 'get_orders')]
    expect(pickStepForTool(steps, 'get_orders')?.id).toBe('s1')
  })

  it('leaves a running step running so the chip can show it working', () => {
    // begin → running happens before the tool executes; the picker must still be
    // able to find that step when the same call closes it.
    const steps = [step('s1', 'running', 'get_orders'), step('s2', 'pending')]
    expect(pickStepForTool(steps, 'get_orders')?.status).toBe('running')
  })
})

describe('continuationAfterTrackerSettlement', () => {
  it('suppresses a stale deadline continuation only after durable completion', () => {
    expect(continuationAfterTrackerSettlement(true, 'completed')).toBe(false)
    expect(continuationAfterTrackerSettlement(true, 'running')).toBe(true)
    expect(continuationAfterTrackerSettlement(false, 'completed')).toBe(false)
  })

  it('uses durable plan rows when the completed snapshot write deduplicates', () => {
    expect(continuationAfterPlanRowsSettlement(true, [
      step('read', 'done', 'get_orders'),
      step('summary', 'done'),
    ])).toBe(false)
    expect(continuationAfterPlanRowsSettlement(true, [
      step('read', 'done', 'get_orders'),
      step('summary', 'running'),
    ])).toBe(true)
    expect(continuationAfterPlanRowsSettlement(true, [])).toBe(true)
  })

  it('restores continuation when a projected delivery close is not durable', () => {
    expect(projectedDeliveryNeedsContinuation('summary', false)).toBe(true)
    expect(projectedDeliveryNeedsContinuation('summary', true)).toBe(false)
    expect(projectedDeliveryNeedsContinuation(null, false)).toBe(false)
  })

  it('preserves the hop budget until a projected close is durable', () => {
    expect(shouldClearContinuationHops({
      taskUnfinished: false, projectedStepId: 'summary', projectedDurablyClosed: false,
    })).toBe(false)
    expect(shouldClearContinuationHops({
      taskUnfinished: false, projectedStepId: 'summary', projectedDurablyClosed: true,
    })).toBe(true)
    expect(shouldClearContinuationHops({
      taskUnfinished: false, projectedStepId: null, projectedDurablyClosed: false,
    })).toBe(true)
  })

  it('keeps a completed-plan recovery bounded until checkpoint close commits', () => {
    expect(completionNeedsCheckpointRetry({
      completionAction: 'complete', projectedStepId: null, checkpointDurablyClosed: false,
    })).toBe(true)
    expect(completionNeedsCheckpointRetry({
      completionAction: 'complete', projectedStepId: null, checkpointDurablyClosed: true,
    })).toBe(false)
    expect(completionNeedsCheckpointRetry({
      completionAction: 'complete', projectedStepId: 'summary', checkpointDurablyClosed: false,
    })).toBe(false)
  })

  it('keeps a plan-bound recovery alive when durable progress cannot be loaded', () => {
    expect(unevaluatedPlanNeedsContinuation({
      planBoundTurn: true, hasOwnerGate: false, planProgressLoaded: false,
    })).toBe(true)
    expect(unevaluatedPlanNeedsContinuation({
      planBoundTurn: true, hasOwnerGate: false, planProgressLoaded: true,
    })).toBe(false)
    expect(unevaluatedPlanNeedsContinuation({
      planBoundTurn: true, hasOwnerGate: true, planProgressLoaded: false,
    })).toBe(false)
  })
})

describe('ownerBlockerFromToolResult', () => {
  it('treats a staged approval as waiting-owner evidence, not completed work', () => {
    expect(ownerBlockerFromToolResult({
      success: true,
      data: { pendingActionId: 'approval-9', awaitingApproval: true },
    })).toEqual({ kind: 'approval', refId: 'approval-9' })
  })

  it('uses the durable action status to distinguish approval cards from job handles', () => {
    const result = {
      success: true,
      data: { pendingActionId: 'job-9', awaitingApproval: true },
    }
    expect(ownerBlockerFromToolResult(result, 'pending')).toEqual({
      kind: 'approval',
      refId: 'job-9',
    })
    expect(ownerBlockerFromToolResult(result, 'approved')).toBeNull()
    expect(ownerBlockerFromToolResult(result, 'executed')).toBeNull()
    expect(ownerBlockerFromToolResult({
      success: true,
      data: { pendingActionId: 'job-10' },
    })).toBeNull()
    expect([
      pendingActionTrackerState('pending'),
      pendingActionTrackerState('approved'),
      pendingActionTrackerState('executed'),
      pendingActionTrackerState('failed'),
      pendingActionTrackerState('superseded'),
    ]).toEqual(['approval', 'worker', 'complete', 'failed', 'failed'])
  })

  it('propagates an ask-user card as a question blocker', () => {
    expect(ownerBlockerFromToolResult({
      success: true,
      data: { askCardId: 'ask-4', options: ['Yes', 'No'] },
    })).toEqual({ kind: 'question', refId: 'ask-4' })
  })

  it('does not invent a blocker for completed or failed non-card results', () => {
    expect(ownerBlockerFromToolResult({ success: true, data: { orderId: 'o-1' } })).toBeNull()
    expect(ownerBlockerFromToolResult({
      success: false,
      data: { pendingActionId: 'approval-9' },
    })).toBeNull()
  })
})

describe('pickFinalDeliveryStep', () => {
  it('uses the persisted reply only for the final summary row', () => {
    const steps = [
      step('dashboard', 'done', 'get_dashboard_snapshot'),
      step('orders', 'done', 'get_orders'),
      step('approvals', 'done', 'get_pending_approvals'),
      { ...step('summary', 'pending'), action: 'Cross-check and summarize' },
    ]
    expect(pickFinalDeliveryStep(steps)?.id).toBe('summary')
  })

  it('never hides unfinished work behind a final reply', () => {
    const steps = [
      step('orders', 'pending', 'get_orders'),
      { ...step('summary', 'pending'), action: 'Cross-check and summarize' },
    ]
    expect(pickFinalDeliveryStep(steps)).toBeNull()
  })

  it('does not count a bare verification or review step as prose delivery', () => {
    expect(pickFinalDeliveryStep([
      step('read', 'done', 'get_orders'),
      { ...step('verify', 'pending'), action: 'Verify the real Simulator result' },
    ])).toBeNull()
    expect(pickFinalDeliveryStep([
      step('read', 'done', 'get_orders'),
      { ...step('review', 'pending'), action: 'Review security permissions' },
    ])).toBeNull()
  })
})

describe('projectFinalDeliveryForCompletion', () => {
  const completedReads = [
    step('dashboard', 'done', 'get_dashboard_snapshot'),
    step('orders', 'done', 'get_orders'),
    step('approvals', 'done', 'get_pending_approvals'),
    { ...step('summary', 'pending'), action: 'Cross-check and summarize' },
  ]
  const rows = completedReads.map((item, index) => ({
    seq: index + 1,
    action: item.action,
    status: item.status,
  }))

  it('lets the completion gate count only a produced final delivery reply', () => {
    const projected = projectFinalDeliveryForCompletion(rows, completedReads, true)
    expect(projected.projectedStepId).toBe('summary')
    expect(projected.rows.map((row) => row.status)).toEqual(['done', 'done', 'done', 'done'])
    expect(rows[3].status).toBe('pending')
  })

  it('does not project when there is no final reply yet', () => {
    expect(projectFinalDeliveryForCompletion(rows, completedReads, false)).toEqual({
      rows,
      projectedStepId: null,
    })
  })

  it('never projects over an earlier unfinished read step', () => {
    const unfinished = [
      step('orders', 'pending', 'get_orders'),
      { ...step('summary', 'pending'), action: 'Cross-check and summarize' },
    ]
    const unfinishedRows = unfinished.map((item, index) => ({
      seq: index + 1,
      action: item.action,
      status: item.status,
    }))
    expect(projectFinalDeliveryForCompletion(unfinishedRows, unfinished, true).projectedStepId).toBeNull()
  })
})

describe('native Anthropic loop tracker parity', () => {
  it('advances real tool steps and binds the terminal snapshot after reply persistence', () => {
    const source = readFileSync(new URL('../core.ts', import.meta.url), 'utf8')
    expect(source).toContain('beginPlanStepForTool(nativeTrackerPlanSteps, tb.name)')
    expect(source).toMatch(/finishPlanStep\(\{\s+stepId: claimedStepId/)
    expect(source).toContain('pickFinalDeliveryStep(nativeTrackerPlanSteps)')
    expect(source).toContain('ownerBlockerFromToolResult(r.result, blockerActionStatus)')
    expect(source).toContain("select: { status: true }")
    expect(source).toContain('linkPendingActionToPlanStep(ownerBlocker.refId, claimedStepId)')
    expect(source).toContain('pendingActionTrackerState(blockerActionStatus)')
    expect(source).toContain("actionTrackerState === 'worker'")
    expect(source).toContain("nativeTrackerBlockedBy = { kind: 'worker', refId: blockerActionId }")
    expect(source).toContain('linkPendingActionToPlanStep(blockerActionId, claimedStepId)')
    expect(source).toContain('settlePlanStepsLinkedToPendingAction(blockerActionId)')
    expect(source).toContain('settlePlanStepsLinkedToPendingAction(ownerBlocker.refId)')
    expect(source).toContain('completePlanStepsLinkedToAskCard(ownerBlocker.refId)')
    expect(source).toContain("actionTrackerState === 'failed'")
    expect(source).toContain('linkAskCardToPlanStep(ownerBlocker.refId, claimedStepId)')
    expect(source).toContain('if (linked)')
    expect(source).toContain('await markStepBlocked(claimedStepId)')
    expect(source).toContain('blockedBy: nativeTrackerBlockedBy')
    expect(source).toContain('if (claimedStepId || ownerBlocker)')
    expect(source).toContain('bindAssistantMessageId: nativeTrackerOriginTurnId === turnId')
  })

  it('keeps alternate-provider approvals, questions, and workers tied to durable outcomes', () => {
    const source = readFileSync(new URL('../models/run-owner-turn.ts', import.meta.url), 'utf8')
    expect(source).toContain('ownerBlockerFromToolResult(input.result, blockerActionStatus)')
    expect(source).toContain('linkPendingActionToPlanStep(ownerBlocker.refId, stepId)')
    expect(source).toContain('linkAskCardToPlanStep(ownerBlocker.refId, stepId)')
    expect(source).toContain('settlePlanStepsLinkedToPendingAction(blockerActionId)')
    expect(source).toContain('completePlanStepsLinkedToAskCard(ownerBlocker.refId)')
    expect(source).toContain("workStepsBlocker = { kind: 'worker', refId: blockerActionId }")
    expect(source).toContain("console.warn('[plan-tracker] alternate settlement deferred:'")
  })

  it('settles a question row from both durable answer paths', () => {
    const answerSource = readFileSync(new URL('../ask-cards.ts', import.meta.url), 'utf8')
    const turnSource = readFileSync(new URL('../models/run-owner-turn.ts', import.meta.url), 'utf8')
    expect(answerSource).toContain('await completePlanStepsLinkedToAskCard(cardId)')
    expect(answerSource.match(/await settleLinkedPlanSteps\(cardId\)/g)).toHaveLength(3)
    expect(turnSource).toContain('await completePlanStepsLinkedToAskCard(matchedAskCard.id)')
  })

  it('settles linked plan rows from every approval-card expiration path', () => {
    const approveSource = readFileSync(
      new URL('../../../app/api/assistant/actions/[id]/approve/route.ts', import.meta.url),
      'utf8',
    )
    const reviseSource = readFileSync(
      new URL('../../../app/api/assistant/actions/[id]/revise/route.ts', import.meta.url),
      'utf8',
    )
    const sweepSource = readFileSync(
      new URL('../../../app/api/assistant/actions/route.ts', import.meta.url),
      'utf8',
    )
    expect(approveSource).toMatch(
      /data: \{ status: 'expired',[\s\S]{0,400}settlePlanStepsLinkedToPendingAction\(actionId\)/,
    )
    expect(reviseSource).toMatch(
      /data: \{ status: 'expired',[\s\S]{0,400}settlePlanStepsLinkedToPendingAction\(actionId\)/,
    )
    expect(sweepSource).toMatch(
      /status: 'expired'[\s\S]{0,800}settlePlanStepsLinkedToPendingAction\(actionId\)/,
    )
  })
})
