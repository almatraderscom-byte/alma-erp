/**
 * Phase 34 — universal interrupt/ask/approval/resume bridge.
 *
 * Contract tests for EVERY staged action category (roadmap exit gate):
 * typed interrupt payload, resume for each decision kind, double-resume
 * idempotency, stale-version zero-effects, revision-requires-new-card, and
 * resume after a simulated multi-day gap (the saver holds the thread; time
 * plays no part in the contract).
 */
import { describe, it, expect } from 'vitest'
import { MemorySaver } from '@langchain/langgraph'
import {
  buildDecisionBridgeGraph,
  stageDecisionThread,
  resumeDecisionThread,
  guardBridgeDecision,
  bridgeVerdictMessageBn,
  bridgeThreadIdFor,
  type BridgeInterruptPayload,
  type BridgeDecision,
} from '@/agent/lib/graph/action-bridge'

/** The staged action categories the ERP ships today (state-router families). */
const CATEGORIES = [
  'log_expense', 'fb_post', 'staff_dispatch', 'campaign_budget', 'browser_task',
  'outbound_call', 'seo_fix', 'product_publish', 'image_gen',
] as const

function payloadFor(type: string, i: number): BridgeInterruptPayload {
  return {
    actionType: type,
    cardKind: type === 'ask' ? 'ask' : 'approval',
    cardId: `card-${type}-${i}`,
    summary: `${type} decision`,
    workflowRunId: `run-${i}`,
    expectedStateVersion: 3,
  }
}

describe('typed stage + resume for every category', () => {
  const decisions: BridgeDecision[] = ['approve', 'reject', 'revise', 'cancel', 'ask_answer', 'external_handoff']

  it('stages a paused thread with the typed payload and resumes each decision kind exactly once', async () => {
    let i = 0
    for (const type of CATEGORIES) {
      const saver = new MemorySaver()
      const decision = decisions[i % decisions.length]
      const p = payloadFor(type, i)
      const staged = await stageDecisionThread(p, { checkpointer: saver })
      expect(staged.staged, type).toBe(true)
      expect(staged.threadId).toBe(bridgeThreadIdFor(p.cardId))

      const r = await resumeDecisionThread(
        { decision, cardId: p.cardId, expectedStateVersion: 3 },
        { checkpointer: saver },
      )
      expect(r.resumed, `${type}/${decision}`).toBe(true)
      expect(r.alreadyConsumed).toBe(false)
      if (decision === 'approve') {
        expect(r.verdict).toBe('ok')
        expect(r.applied).toBe(true)
      }
      i++
    }
  })

  it('the interrupt payload is the typed card contract (visible to the pause consumer)', async () => {
    const saver = new MemorySaver()
    const graph = buildDecisionBridgeGraph(saver)
    const p = payloadFor('fb_post', 99)
    const cfg = { configurable: { thread_id: bridgeThreadIdFor(p.cardId), checkpoint_ns: 'action_bridge' } }
    const out = await graph.invoke({ payload: p }, cfg)
    const interrupts = (out as Record<string, unknown>).__interrupt__ as Array<{ value: BridgeInterruptPayload }>
    expect(interrupts).toHaveLength(1)
    expect(interrupts[0].value).toMatchObject({
      actionType: 'fb_post', cardKind: 'approval', cardId: p.cardId,
      workflowRunId: 'run-99', expectedStateVersion: 3,
    })
  })
})

describe('idempotency (exit gate: duplicate approve = one effect)', () => {
  it('a second resume reports alreadyConsumed and applies nothing', async () => {
    const saver = new MemorySaver()
    const p = payloadFor('log_expense', 1)
    await stageDecisionThread(p, { checkpointer: saver })
    const first = await resumeDecisionThread({ decision: 'approve', cardId: p.cardId, expectedStateVersion: 3 }, { checkpointer: saver })
    expect(first.applied).toBe(true)
    const second = await resumeDecisionThread({ decision: 'approve', cardId: p.cardId, expectedStateVersion: 3 }, { checkpointer: saver })
    expect(second.alreadyConsumed).toBe(true)
    expect(second.applied).toBe(false)
    // The first verdict is still readable — reconnect UX can show the truth.
    expect(second.verdict).toBe('ok')
  })

  it('reject then approve on the same thread: approve finds it consumed (zero effects)', async () => {
    const saver = new MemorySaver()
    const p = payloadFor('staff_dispatch', 2)
    await stageDecisionThread(p, { checkpointer: saver })
    const rej = await resumeDecisionThread({ decision: 'reject', cardId: p.cardId }, { checkpointer: saver })
    expect(rej.resumed).toBe(true)
    const app = await resumeDecisionThread({ decision: 'approve', cardId: p.cardId, expectedStateVersion: 3 }, { checkpointer: saver })
    expect(app.alreadyConsumed).toBe(true)
    expect(app.applied).toBe(false)
  })

  it('revise consumes the pre-revise thread so its stale payload can never fire', async () => {
    const saver = new MemorySaver()
    const p = payloadFor('campaign_budget', 3)
    await stageDecisionThread(p, { checkpointer: saver })
    const rev = await resumeDecisionThread({ decision: 'revise', cardId: p.cardId, text: 'budget 500 koro' }, { checkpointer: saver })
    expect(rev.resumed).toBe(true)
    const app = await resumeDecisionThread({ decision: 'approve', cardId: p.cardId, expectedStateVersion: 3 }, { checkpointer: saver })
    expect(app.alreadyConsumed).toBe(true)
    expect(app.applied).toBe(false)
  })

  it('resume after a simulated three-day gap continues the same thread (saver-durable)', async () => {
    const saver = new MemorySaver()
    const p = payloadFor('browser_task', 4)
    await stageDecisionThread(p, { checkpointer: saver })
    // "Three days later" = a fresh process resuming the persisted thread; the
    // contract has no clock — only durable state. New graph instance, same saver.
    const r = await resumeDecisionThread({ decision: 'approve', cardId: p.cardId, expectedStateVersion: 3 }, { checkpointer: saver })
    expect(r.resumed).toBe(true)
    expect(r.applied).toBe(true)
  })
})

describe('guard matrix (pure, zero effects on every refusal)', () => {
  const base = { card: { id: 'c1', status: 'pending' as string }, resume: { decision: 'approve' as BridgeDecision, cardId: 'c1' } }

  it('ok on a clean approve', () => {
    expect(guardBridgeDecision({ ...base })).toBe('ok')
  })
  it('already_resolved on any non-pending status', () => {
    for (const status of ['approved', 'executed', 'rejected', 'expired', 'cancelled']) {
      expect(guardBridgeDecision({ ...base, card: { id: 'c1', status } })).toBe('already_resolved')
    }
  })
  it('expired card refuses with zero effects', () => {
    expect(guardBridgeDecision({ ...base, card: { id: 'c1', status: 'pending', expired: true } })).toBe('expired')
  })
  it('stale version: run moved past the staged version', () => {
    expect(guardBridgeDecision({ ...base, stagedStateVersion: 3, liveStateVersion: 5 })).toBe('stale_version')
    expect(guardBridgeDecision({ ...base, stagedStateVersion: 3, liveStateVersion: 3 })).toBe('ok')
  })
  it('approve with modified effect fields requires a NEW card', () => {
    expect(guardBridgeDecision({ ...base, hasRevisedFields: true })).toBe('revision_requires_new_card')
  })
  it('a decision aimed at another card is refused', () => {
    expect(guardBridgeDecision({ ...base, resume: { decision: 'approve', cardId: 'OTHER' } })).toBe('wrong_card')
  })
  it('reject/cancel are exempt from version + revision guards (they only close)', () => {
    expect(guardBridgeDecision({ ...base, resume: { decision: 'reject', cardId: 'c1' }, stagedStateVersion: 3, liveStateVersion: 9 })).toBe('ok')
    expect(guardBridgeDecision({ ...base, resume: { decision: 'cancel', cardId: 'c1' }, hasRevisedFields: true })).toBe('ok')
  })
  it('every refusal has a clear Bangla message', () => {
    for (const v of ['already_resolved', 'expired', 'stale_version', 'revision_requires_new_card', 'wrong_card'] as const) {
      expect(bridgeVerdictMessageBn(v).length).toBeGreaterThan(10)
    }
  })
})
