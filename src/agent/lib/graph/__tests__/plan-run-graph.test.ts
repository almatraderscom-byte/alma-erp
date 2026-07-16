/**
 * LG-9 slice 2 — plan-run graph, offline behaviour lock.
 *
 * Contracts: one checkpoint per drive tick (plan replayable with running
 * stepsDone/cost totals), plans isolated by thread, gate + fail-open
 * discipline. Real graph on MemorySaver.
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

import { mirrorPlanDriveTick, getPlanRunHistory } from '../plan-run-graph'

beforeEach(() => {
  saver = new MemorySaver()
  process.env.AGENT_LANGGRAPH_WORKFLOW = 'true'
})

describe('plan-run graph (autodrive pilot)', () => {
  it('replays a plan drive: steps, block, totals', async () => {
    const plan = 'plan-1'
    expect(await mirrorPlanDriveTick(plan, { outcome: 'step-done', stepAction: 'রিসার্চ শেষ করো', detail: 'রিসার্চ শেষ করো', costTaka: 4 })).toBe(1)
    expect(await mirrorPlanDriveTick(plan, { outcome: 'blocked-approval', stepAction: 'ক্যাম্পেইন launch', detail: 'ক্যাম্পেইন launch', costTaka: 2 })).toBe(2)
    expect(await mirrorPlanDriveTick(plan, { outcome: 'step-done', stepAction: 'ক্যাম্পেইন launch', detail: 'ক্যাম্পেইন launch', costTaka: 3 })).toBe(3)
    expect(await mirrorPlanDriveTick(plan, { outcome: 'plan-done', stepAction: null, detail: 'সব ধাপ শেষ', costTaka: 1 })).toBe(4)

    const h = await getPlanRunHistory(plan)
    expect(h.ticks).toHaveLength(4)
    expect(h.ticks[0].outcome).toBe('plan-done') // newest first
    expect(h.ticks.map((t) => t.outcome)).toEqual(['plan-done', 'step-done', 'blocked-approval', 'step-done'])
    expect(h.stepsDone).toBe(2)
    expect(h.totalCostTaka).toBe(10)
  })

  it('plans are isolated threads', async () => {
    await mirrorPlanDriveTick('plan-a', { outcome: 'step-done', stepAction: 'a', detail: 'a', costTaka: 1 })
    await mirrorPlanDriveTick('plan-b', { outcome: 'step-failed', stepAction: 'b', detail: 'boom', costTaka: 0 })
    expect((await getPlanRunHistory('plan-a')).ticks).toHaveLength(1)
    expect((await getPlanRunHistory('plan-b')).ticks[0].outcome).toBe('step-failed')
  })

  it('gate off / checkpointer down → fail-open null and empty history', async () => {
    process.env.AGENT_LANGGRAPH_WORKFLOW = 'false'
    expect(await mirrorPlanDriveTick('p', { outcome: 'step-done', stepAction: null, detail: null, costTaka: 0 })).toBeNull()
    expect(await getPlanRunHistory('p')).toEqual({ ticks: [], stepsDone: 0, totalCostTaka: 0 })

    process.env.AGENT_LANGGRAPH_WORKFLOW = 'true'
    saver = null
    expect(await mirrorPlanDriveTick('p2', { outcome: 'step-done', stepAction: null, detail: null, costTaka: 0 })).toBeNull()
  })
})
