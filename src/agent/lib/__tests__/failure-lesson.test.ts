/**
 * Auto post-mortem lesson (2026-07-16): a FAILED workflow transition leaves a
 * 'proposed' playbook row (owner-reviewable), deduped per kind+state per week;
 * done/cancelled runs never write lessons.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

interface RunRow { id: string; kind: string; goal: string; businessId: string; status: string; state: string; stateVersion: number }
const runs: RunRow[] = []
const playbook: Array<Record<string, unknown>> = []

vi.mock('@/lib/prisma', () => ({
  prisma: {
    workflowRun: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => runs.find((r) => r.id === where.id) ?? null),
      updateMany: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = runs.find((r) => r.id === where.id)
        if (row) row.stateVersion += 1
        return { count: row ? 1 : 0 }
      }),
    },
    workflowRunEvent: { create: vi.fn(async () => ({})) },
    agentOpenTask: { updateMany: vi.fn(async () => ({ count: 0 })) },
    agentPlaybook: {
      findFirst: vi.fn(async ({ where }: { where: { domain: string; heuristic?: { contains: string } } }) =>
        playbook.find((p) => p.domain === where.domain && (!where.heuristic || String(p.heuristic).includes(where.heuristic.contains))) ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        playbook.push({ ...data, createdAt: new Date() })
        return data
      }),
    },
  },
}))
vi.mock('@/agent/lib/graph/workflow-run-graph', () => ({
  mirrorWorkflowRunTransition: vi.fn(async () => null),
  getWorkflowRunGraphHistory: vi.fn(async () => [
    { state: 'draft_ready', cause: 'turn', labelBn: '', status: 'active', legal: true, checkpointId: null, createdAt: null },
    { state: 'rendering', cause: 'worker_timeout', labelBn: '', status: 'failed', legal: true, checkpointId: null, createdAt: null },
  ]),
}))

import { transitionWorkflowRun } from '@/agent/lib/workflow-run'

beforeEach(() => {
  runs.length = 0
  playbook.length = 0
})

describe('auto failure lesson', () => {
  it('a failed transition writes ONE proposed lesson with trail evidence', async () => {
    runs.push({ id: 'r1', kind: 'product_post', goal: 'ঈদ পোস্ট', businessId: 'ALMA_LIFESTYLE', status: 'active', state: 'rendering', stateVersion: 1 })
    await transitionWorkflowRun({ runId: 'r1', expectedVersion: 1, toStatus: 'failed', toState: 'rendering', cause: 'worker_timeout' })
    expect(playbook).toHaveLength(1)
    expect(playbook[0].status).toBe('proposed')
    expect(playbook[0].domain).toBe('postmortem:product_post')
    expect(String(playbook[0].heuristic)).toContain("ধাপ 'rendering'")
    expect(String(playbook[0].evidence)).toContain('trail:')
  })

  it('dedupes: second same-kind+state failure in the week writes nothing', async () => {
    runs.push({ id: 'r1', kind: 'product_post', goal: 'x', businessId: 'ALMA_LIFESTYLE', status: 'active', state: 'rendering', stateVersion: 1 })
    runs.push({ id: 'r2', kind: 'product_post', goal: 'y', businessId: 'ALMA_LIFESTYLE', status: 'active', state: 'rendering', stateVersion: 1 })
    await transitionWorkflowRun({ runId: 'r1', expectedVersion: 1, toStatus: 'failed', toState: 'rendering', cause: 'a' })
    await transitionWorkflowRun({ runId: 'r2', expectedVersion: 1, toStatus: 'failed', toState: 'rendering', cause: 'b' })
    expect(playbook).toHaveLength(1)
  })

  it('done/cancelled transitions never write lessons', async () => {
    runs.push({ id: 'r1', kind: 'product_post', goal: 'x', businessId: 'ALMA_LIFESTYLE', status: 'active', state: 'post_approval', stateVersion: 1 })
    await transitionWorkflowRun({ runId: 'r1', expectedVersion: 1, toStatus: 'done', toState: 'published_verified', cause: 'card_executed' })
    expect(playbook).toHaveLength(0)
  })
})
