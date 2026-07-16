/**
 * LG-6 slice 2 — template workflow-run graph mirror, offline behaviour lock.
 *
 * Contracts: one checkpoint per transition (getStateHistory replays the run),
 * template legality re-checked from the SAME step map the engine uses (off-map
 * recorded as legal:false, never blocking), gate + fail-open discipline.
 * Real graph on MemorySaver.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemorySaver } from '@langchain/langgraph'

let saver: MemorySaver | null = new MemorySaver()
vi.mock('@/agent/lib/graph/graph-checkpointer', () => ({
  getGraphCheckpointer: () => saver,
  checkpointConfigFor: (o: { conversationId?: string | null; namespace: string }) => ({
    configurable: { thread_id: o.conversationId ?? 'anon', checkpoint_ns: o.namespace },
    metadata: {},
    durability: 'sync',
  }),
}))

import {
  mirrorWorkflowRunTransition,
  getWorkflowRunGraphHistory,
} from '../workflow-run-graph'

beforeEach(() => {
  saver = new MemorySaver()
  process.env.AGENT_LANGGRAPH_WORKFLOW = 'true'
})

function transition(runId: string, from: string, to: string, cause: string, status = 'active', version = 1) {
  return mirrorWorkflowRunTransition({
    runId,
    kind: 'product_post',
    status,
    state: to,
    event: { fromStatus: 'active', toStatus: status, fromState: from, toState: to, cause, stateVersion: version },
  })
}

describe('mirrorWorkflowRunTransition (content pipeline pilot)', () => {
  it('mirrors the full product_post happy path — every step its own checkpoint', async () => {
    const runId = 'run-happy'
    await mirrorWorkflowRunTransition({ runId, kind: 'product_post', status: 'active', state: 'draft_ready', event: null })
    expect((await transition(runId, 'draft_ready', 'creative_approval', 'card_staged', 'waiting_owner', 1))?.legal).toBe(true)
    expect((await transition(runId, 'creative_approval', 'rendering', 'card_approved', 'waiting_worker', 2))?.legal).toBe(true)
    expect((await transition(runId, 'rendering', 'preview_confirm', 'worker_done', 'active', 3))?.legal).toBe(true)
    expect((await transition(runId, 'preview_confirm', 'post_draft', 'ask_answer', 'active', 4))?.legal).toBe(true)
    expect((await transition(runId, 'post_draft', 'post_approval', 'card_staged', 'waiting_owner', 5))?.legal).toBe(true)
    expect((await transition(runId, 'post_approval', 'published_verified', 'card_executed', 'done', 6))?.legal).toBe(true)

    const history = await getWorkflowRunGraphHistory(runId)
    // 7 apply_transition checkpoints (seed + 6 transitions) + the initial
    // empty-input checkpoint chain LangGraph writes per invoke.
    const states = history.map((s) => s.state).filter(Boolean)
    expect(states[0]).toBe('published_verified') // newest first
    expect(states).toContain('draft_ready')
    expect(states).toContain('preview_confirm')
    expect(history[0].labelBn).toContain('পাবলিশ')
    expect(history.every((s) => s.legal)).toBe(true)
  })

  it('records an off-map jump as legal:false without blocking (drift signal)', async () => {
    const runId = 'run-offmap'
    await mirrorWorkflowRunTransition({ runId, kind: 'product_post', status: 'active', state: 'draft_ready', event: null })
    const out = await transition(runId, 'draft_ready', 'published_verified', 'mystery_jump', 'done', 1)
    expect(out?.legal).toBe(false)
    const history = await getWorkflowRunGraphHistory(runId)
    expect(history[0].state).toBe('published_verified')
    expect(history[0].legal).toBe(false)
  })

  it('rejected card back-jump (preview_confirm → draft_ready) is ON the map', async () => {
    const runId = 'run-reject'
    await mirrorWorkflowRunTransition({ runId, kind: 'product_post', status: 'active', state: 'preview_confirm', event: null })
    const out = await transition(runId, 'preview_confirm', 'draft_ready', 'ask_answer_change', 'active', 1)
    expect(out?.legal).toBe(true)
  })

  it('non-template kinds mirror with legal:true and no label', async () => {
    const runId = 'run-generic'
    const out = await mirrorWorkflowRunTransition({
      runId, kind: 'some_custom_kind', status: 'active', state: 'anything',
      event: { fromStatus: 'active', toStatus: 'active', fromState: 'started', toState: 'anything', cause: 'x', stateVersion: 1 },
    })
    expect(out?.legal).toBe(true)
    const history = await getWorkflowRunGraphHistory(runId)
    expect(history[0].state).toBe('anything')
    expect(history[0].labelBn).toBe('')
  })

  it('gate off → null, no checkpoints; checkpointer down → fail-open null', async () => {
    process.env.AGENT_LANGGRAPH_WORKFLOW = 'false'
    expect(await mirrorWorkflowRunTransition({ runId: 'r', kind: 'product_post', status: 'active', state: 's', event: null })).toBeNull()
    expect(await getWorkflowRunGraphHistory('r')).toEqual([])

    process.env.AGENT_LANGGRAPH_WORKFLOW = 'true'
    saver = null
    expect(await mirrorWorkflowRunTransition({ runId: 'r2', kind: 'product_post', status: 'active', state: 's', event: null })).toBeNull()
    expect(await getWorkflowRunGraphHistory('r2')).toEqual([])
  })
})
