/**
 * LG-6 slice 1 — SEO batch graph mirror, offline behaviour lock.
 *
 * Contracts: the mirror applies the SAME reducer as the legacy row (one truth);
 * each transition is its own checkpoint so getStateHistory replays the run
 * step-by-step; gate + fail-open discipline. Real graph on MemorySaver.
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

import { createClientSeoBatchFacts, reduceClientSeoBatch, clientSeoBatchStateLabel } from '@/agent/lib/client-seo-batch-state'
import {
  isWorkflowGraphEnabled,
  mirrorSeoBatchTransition,
  getSeoBatchGraphHistory,
} from '../seo-batch-graph'

beforeEach(() => {
  saver = new MemorySaver()
  process.env.AGENT_LANGGRAPH_WORKFLOW = 'true'
})

describe('isWorkflowGraphEnabled (rollout discipline)', () => {
  it('force-on / kill switch / preview default / production default', () => {
    delete process.env.AGENT_LANGGRAPH_WORKFLOW
    expect(isWorkflowGraphEnabled('true', 'production')).toBe(true)
    expect(isWorkflowGraphEnabled('false', 'preview')).toBe(false)
    expect(isWorkflowGraphEnabled(undefined, 'preview')).toBe(true)
    expect(isWorkflowGraphEnabled(undefined, 'production')).toBe(false)
  })
})

describe('mirror + history round-trip', () => {
  it('seed + transitions replay as step-by-step history with reducer-true labels', async () => {
    const facts0 = createClientSeoBatchFacts(['https://client-a.com'], {
      requireLiveBrowser: false,
      requireArtifact: true,
    })
    // Seed
    const seedLabel = await mirrorSeoBatchTransition({ runId: 'run-1', facts: facts0, event: null })
    expect(seedLabel).toBe(clientSeoBatchStateLabel(facts0)) // target_1_audit_queue (no browser required)

    // audit queued → audit finished → report → links, mirroring exactly what
    // the legacy path does: each mirror gets the PRE-transition facts + event.
    const e1 = { type: 'audit_queued', actionId: 'a-1' } as const
    const facts1 = reduceClientSeoBatch(facts0, e1)
    expect(await mirrorSeoBatchTransition({ runId: 'run-1', facts: facts0, event: e1, legacyStateLabel: clientSeoBatchStateLabel(facts1) }))
      .toBe(clientSeoBatchStateLabel(facts1))

    const e2 = { type: 'audit_finished', actionId: 'a-1', ok: true } as const
    const facts2 = reduceClientSeoBatch(facts1, e2)
    expect(await mirrorSeoBatchTransition({ runId: 'run-1', facts: facts1, event: e2, legacyStateLabel: clientSeoBatchStateLabel(facts2) }))
      .toBe(clientSeoBatchStateLabel(facts2))

    const history = await getSeoBatchGraphHistory('run-1')
    expect(history.length).toBeGreaterThanOrEqual(3)
    // Newest first; every step carries a checkpoint id (the replay handle).
    expect(history[0].stateLabel).toBe(clientSeoBatchStateLabel(facts2))
    expect(history[0].eventType).toBe('audit_finished')
    expect(history.every((s) => s.checkpointId)).toBe(true)
  })

  it('threads are isolated per run', async () => {
    const facts = createClientSeoBatchFacts(['https://client-b.com'], { requireLiveBrowser: false, requireArtifact: false })
    await mirrorSeoBatchTransition({ runId: 'run-A', facts, event: null })
    expect(await getSeoBatchGraphHistory('run-B')).toEqual([])
  })

  it('gate off → mirror null, history []', async () => {
    process.env.AGENT_LANGGRAPH_WORKFLOW = 'false'
    const facts = createClientSeoBatchFacts(['https://c.com'], { requireLiveBrowser: false, requireArtifact: false })
    expect(await mirrorSeoBatchTransition({ runId: 'run-x', facts, event: null })).toBeNull()
    expect(await getSeoBatchGraphHistory('run-x')).toEqual([])
  })

  it('no checkpointer → fail-open null', async () => {
    saver = null
    const facts = createClientSeoBatchFacts(['https://c.com'], { requireLiveBrowser: false, requireArtifact: false })
    expect(await mirrorSeoBatchTransition({ runId: 'run-x', facts, event: null })).toBeNull()
  })
})
