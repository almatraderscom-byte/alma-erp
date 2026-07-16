/**
 * LG-6 slice 3 — live-browser session graph, offline behaviour lock.
 *
 * Contracts: every look/act step is its own checkpoint (getStateHistory
 * replays the session, scroll telemetry included), stepCount accumulates,
 * 'na' conversation never writes, gate + fail-open discipline.
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

import { mirrorLiveBrowserStep, getLiveBrowserGraphHistory } from '../live-browser-graph'

beforeEach(() => {
  saver = new MemorySaver()
  process.env.AGENT_LANGGRAPH_WORKFLOW = 'true'
})

describe('live-browser session graph', () => {
  it('checkpoints every step with scroll telemetry, replayable newest-first', async () => {
    const conv = 'conv-1'
    expect(
      await mirrorLiveBrowserStep(conv, {
        action: 'look', url: 'https://queenspabd.com', detail: 'open:https://queenspabd.com',
        scrollY: 0, pageHeight: 5200, atBottom: false, textRead: 12000, ok: true,
      }),
    ).toBe(1)
    expect(
      await mirrorLiveBrowserStep(conv, {
        action: 'scroll', url: null, detail: 'by:800',
        scrollY: 800, pageHeight: 5200, atBottom: false, textRead: null, ok: true,
      }),
    ).toBe(2)
    expect(
      await mirrorLiveBrowserStep(conv, {
        action: 'look', url: 'https://queenspabd.com', detail: 'sweep',
        scrollY: 5200, pageHeight: 5200, atBottom: true, textRead: 28000, ok: true,
      }),
    ).toBe(3)

    const history = await getLiveBrowserGraphHistory(conv)
    expect(history.length).toBeGreaterThanOrEqual(3)
    expect(history[0].stepNo).toBe(3)
    expect(history[0].atBottom).toBe(true)
    expect(history[0].textRead).toBe(28000)
    const actions = history.map((s) => s.action)
    expect(actions).toContain('scroll')
    expect(actions.filter((a) => a === 'look')).toHaveLength(2)
  })

  it('sessions are isolated per conversation', async () => {
    await mirrorLiveBrowserStep('conv-a', { action: 'look', url: 'https://a.com', detail: null, scrollY: null, pageHeight: null, atBottom: null, textRead: null, ok: true })
    await mirrorLiveBrowserStep('conv-b', { action: 'look', url: 'https://b.com', detail: null, scrollY: null, pageHeight: null, atBottom: null, textRead: null, ok: true })
    const a = await getLiveBrowserGraphHistory('conv-a')
    expect(a.every((s) => s.url !== 'https://b.com')).toBe(true)
  })

  it("'na' conversation (no id injected) never writes", async () => {
    expect(
      await mirrorLiveBrowserStep('na', { action: 'look', url: null, detail: null, scrollY: null, pageHeight: null, atBottom: null, textRead: null, ok: true }),
    ).toBeNull()
  })

  it('gate off / checkpointer down → fail-open null and empty history', async () => {
    process.env.AGENT_LANGGRAPH_WORKFLOW = 'false'
    expect(
      await mirrorLiveBrowserStep('c', { action: 'look', url: null, detail: null, scrollY: null, pageHeight: null, atBottom: null, textRead: null, ok: true }),
    ).toBeNull()
    expect(await getLiveBrowserGraphHistory('c')).toEqual([])

    process.env.AGENT_LANGGRAPH_WORKFLOW = 'true'
    saver = null
    expect(
      await mirrorLiveBrowserStep('c2', { action: 'look', url: null, detail: null, scrollY: null, pageHeight: null, atBottom: null, textRead: null, ok: true }),
    ).toBeNull()
  })
})
