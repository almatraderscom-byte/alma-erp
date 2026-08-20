import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  pickFinalDeliveryStep,
  pickStepForTool,
  ownerBlockerFromToolResult,
  pendingActionTrackerState,
  projectFinalDeliveryForCompletion,
  type AdvanceableStep,
} from '@/agent/lib/plan-step-advance'

const step = (id: string, status: string, toolName?: string): AdvanceableStep =>
  ({ id, action: id, status, toolName: toolName ?? null })

describe('pickStepForTool', () => {
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
    ]).toEqual(['approval', 'worker', 'complete', 'failed'])
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
    expect(source).toContain("actionTrackerState === 'failed'")
    expect(source).toContain('linkAskCardToPlanStep(ownerBlocker.refId, claimedStepId)')
    expect(source).toContain('if (linked)')
    expect(source).toContain('await markStepBlocked(claimedStepId)')
    expect(source).toContain('blockedBy: nativeTrackerBlockedBy')
    expect(source).toContain('if (claimedStepId || ownerBlocker)')
    expect(source).toContain('bindAssistantMessageId: nativeTrackerOriginTurnId === turnId')
  })

  it('settles a question row from both durable answer paths', () => {
    const answerSource = readFileSync(new URL('../ask-cards.ts', import.meta.url), 'utf8')
    const turnSource = readFileSync(new URL('../models/run-owner-turn.ts', import.meta.url), 'utf8')
    expect(answerSource).toContain('await completePlanStepsLinkedToAskCard(cardId)')
    expect(answerSource.match(/await settleLinkedPlanSteps\(cardId\)/g)).toHaveLength(3)
    expect(turnSource).toContain('await completePlanStepsLinkedToAskCard(matchedAskCard.id)')
  })
})
