/**
 * LG-9 slice 1 — duty-run graph, offline behaviour lock.
 *
 * Contracts: one checkpoint per tick (day replayable, quiet reasons + wakes
 * + running totals), days/duties isolated by thread, gate + fail-open
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

import { mirrorDutyTick, getDutyRunDay } from '../duty-run-graph'

beforeEach(() => {
  saver = new MemorySaver()
  process.env.AGENT_LANGGRAPH_WORKFLOW = 'true'
})

describe('duty-run graph (heartbeat pilot)', () => {
  it('replays a day: quiet reasons, wakes, running totals', async () => {
    const day = '2026-07-16'
    expect(await mirrorDutyTick('heartbeat', day, { decision: 'off_hours', outcome: null, summary: null, costUsd: 0, conversationId: null })).toBe(1)
    expect(await mirrorDutyTick('heartbeat', day, { decision: 'unchanged', outcome: null, summary: '২টা অর্ডার pending', costUsd: 0, conversationId: null })).toBe(2)
    expect(await mirrorDutyTick('heartbeat', day, { decision: 'wake', outcome: 'active', summary: 'অর্ডার সামলে নিলাম', costUsd: 0.0034, conversationId: 'conv-hb' })).toBe(3)
    expect(await mirrorDutyTick('heartbeat', day, { decision: 'wake', outcome: 'blocked', summary: 'কার্ড staged', costUsd: 0.002, conversationId: 'conv-hb' })).toBe(4)

    const summary = await getDutyRunDay('heartbeat', day)
    expect(summary.ticks).toHaveLength(4)
    expect(summary.ticks[0].tickNo).toBe(4) // newest first
    expect(summary.ticks.map((t) => t.decision)).toEqual(['wake', 'wake', 'unchanged', 'off_hours'])
    expect(summary.wakes).toBe(2)
    expect(summary.totalCostUsd).toBeCloseTo(0.0054, 6)
    expect(summary.ticks[0].outcome).toBe('blocked')
  })

  it('days and duty keys are isolated threads', async () => {
    await mirrorDutyTick('heartbeat', '2026-07-15', { decision: 'quiet', outcome: null, summary: null, costUsd: 0, conversationId: null })
    await mirrorDutyTick('heartbeat', '2026-07-16', { decision: 'wake', outcome: 'active', summary: null, costUsd: 0.01, conversationId: 'c' })
    await mirrorDutyTick('watchdog', '2026-07-16', { decision: 'quiet', outcome: null, summary: null, costUsd: 0, conversationId: null })

    expect((await getDutyRunDay('heartbeat', '2026-07-15')).ticks).toHaveLength(1)
    const hb16 = await getDutyRunDay('heartbeat', '2026-07-16')
    expect(hb16.ticks).toHaveLength(1)
    expect(hb16.wakes).toBe(1)
    expect((await getDutyRunDay('watchdog', '2026-07-16')).ticks[0].decision).toBe('quiet')
  })

  it('gate off / checkpointer down → fail-open null and empty day', async () => {
    process.env.AGENT_LANGGRAPH_WORKFLOW = 'false'
    expect(await mirrorDutyTick('heartbeat', '2026-07-16', { decision: 'quiet', outcome: null, summary: null, costUsd: 0, conversationId: null })).toBeNull()
    expect(await getDutyRunDay('heartbeat', '2026-07-16')).toEqual({ ticks: [], wakes: 0, totalCostUsd: 0 })

    process.env.AGENT_LANGGRAPH_WORKFLOW = 'true'
    saver = null
    expect(await mirrorDutyTick('heartbeat', '2026-07-16', { decision: 'quiet', outcome: null, summary: null, costUsd: 0, conversationId: null })).toBeNull()
  })
})
