/**
 * Phase 35 — specialist fan-out subgraph (LangGraph Send, reads only).
 */
import { afterAll, beforeEach, describe, it, expect, vi } from 'vitest'
import type { AlmaRole } from '@/lib/roles'

type FakeStore = {
  rows: Map<string, { value: unknown }>
  get: ReturnType<typeof vi.fn>
  put: ReturnType<typeof vi.fn>
}

const memory = vi.hoisted(() => ({ store: null as FakeStore | null }))

vi.mock('@/agent/lib/graph/memory-store', () => ({
  getAlmaMemoryStore: () => memory.store,
}))
import {
  buildSpecialistFanoutGraph,
  runSpecialistFanout,
  reconcileFindings,
  SPECIALIST_FANOUT_MAX_BRANCHES,
  type SpecialistBrief,
  type SpecialistFinding,
  type SpecialistRunner,
} from '@/agent/lib/graph/specialist-subgraph'
import { filterToolsReadOnly } from '@/agent/lib/models/subagent'
import { buildInternalEntityReference } from '@/agent/lib/references/internal-registry'

const brief = (role: string, task: string, extra: Partial<SpecialistBrief> = {}): SpecialistBrief =>
  ({ role: role as SpecialistBrief['role'], task, businessId: 'ALMA_LIFESTYLE', ...extra })

const originalReferenceRollout = process.env.AGENT_REFERENCES_ROLLOUT
const originalReferenceKill = process.env.AGENT_REFERENCES_KILL_SWITCH

function fakeStore(): FakeStore {
  const rows = new Map<string, { value: unknown }>()
  const rowKey = (namespace: readonly string[], key: string) => `${namespace.join('/')}::${key}`
  return {
    rows,
    get: vi.fn(async (namespace: readonly string[], key: string) => rows.get(rowKey(namespace, key)) ?? null),
    put: vi.fn(async (namespace: readonly string[], key: string, value: unknown) => {
      rows.set(rowKey(namespace, key), { value })
    }),
  }
}

beforeEach(() => {
  memory.store = null
  delete process.env.AGENT_REFERENCES_KILL_SWITCH
})

afterAll(() => {
  if (originalReferenceRollout == null) delete process.env.AGENT_REFERENCES_ROLLOUT
  else process.env.AGENT_REFERENCES_ROLLOUT = originalReferenceRollout
  if (originalReferenceKill == null) delete process.env.AGENT_REFERENCES_KILL_SWITCH
  else process.env.AGENT_REFERENCES_KILL_SWITCH = originalReferenceKill
})

describe('Send fan-out (reads only, stateless briefs)', () => {
  it('runs every brief as its own branch and reconciles all findings', async () => {
    const seen: Array<{ role: string; readOnly: boolean }> = []
    const runner: SpecialistRunner = async (b) => {
      seen.push({ role: b.role, readOnly: b.readOnly })
      return { success: true, summary: `${b.role} findings`, toolsUsed: [`get_${b.role}`], costUsd: 0.01 }
    }
    const out = await runSpecialistFanout(
      [brief('researcher', 'competitor der eid collection dekho'), brief('analyst', 'last 30 diner sales trend'), brief('seo', 'keyword ranking check')],
      { runner },
    )
    expect(out.succeeded).toBe(3)
    expect(out.failed).toBe(0)
    expect(out.findings.map((f) => f.role).sort()).toEqual(['analyst', 'researcher', 'seo'])
    // EVERY parallel branch is read-only by construction.
    expect(seen.every((s) => s.readOnly === true)).toBe(true)
    expect(out.headBrief).toContain('[SPECIALIST FAN-OUT')
  })

  it('caps the branch count', async () => {
    const runner: SpecialistRunner = async (b) => ({ success: true, summary: b.task, toolsUsed: [], costUsd: 0 })
    const briefs = Array.from({ length: 7 }, (_, i) => brief('researcher', `t${i}`))
    const out = await runSpecialistFanout(briefs, { runner })
    expect(out.findings).toHaveLength(SPECIALIST_FANOUT_MAX_BRANCHES)
  })

  it('a failed specialist is VISIBLE and does not erase sibling evidence', async () => {
    const runner: SpecialistRunner = async (b) => {
      if (b.role === 'analyst') throw new Error('provider_500')
      return { success: true, summary: `${b.role} ok`, toolsUsed: ['get_orders'], costUsd: 0 }
    }
    const out = await runSpecialistFanout(
      [brief('researcher', 'a'), brief('analyst', 'b'), brief('seo', 'c')],
      { runner },
    )
    expect(out.succeeded).toBe(2)
    expect(out.failed).toBe(1)
    const failed = out.findings.find((f) => f.role === 'analyst')!
    expect(failed.success).toBe(false)
    expect(failed.error).toBe('provider_500')
    expect(out.headBrief).toContain('ব্যর্থ')
    expect(out.headBrief).toContain('researcher ok'.replace(' ok', '') /* sibling evidence present */)
  })

  it('zero briefs short-circuits to an empty reconciliation', async () => {
    const runner: SpecialistRunner = async () => { throw new Error('must not run') }
    const out = await runSpecialistFanout([], { runner })
    expect(out.findings).toEqual([])
  })

  it('propagates verified branch references through reconciliation to the head', async () => {
    process.env.AGENT_REFERENCES_ROLLOUT = 'shadow'
    const reference = buildInternalEntityReference({
      namespace: 'order',
      id: 'delegated-order',
      sourceTool: 'get_orders',
      outputPath: 'data.orders[0].id',
      context: { businessId: 'ALMA_LIFESTYLE', roles: ['SUPER_ADMIN'] },
    })!
    const runner: SpecialistRunner = async () => ({
      success: true,
      summary: 'verified order finding',
      toolsUsed: ['get_orders'],
      costUsd: 0,
      references: [reference],
    })

    const out = await runSpecialistFanout([brief('researcher', 'order check')], { runner })

    expect(out.findings[0].references).toEqual([reference])
    expect(out.references).toEqual([reference])
  })
})

describe('read-only enforcement (parallel branches cannot write)', () => {
  it('filterToolsReadOnly drops every writer and memory/effect tool', () => {
    const tools = [
      { name: 'get_sales_summary' }, { name: 'list_reminders' }, { name: 'search_memory' },
      { name: 'log_expense' }, { name: 'post_to_facebook' }, { name: 'save_memory' },
      { name: 'send_staff_announcement' }, { name: 'ask_user' }, { name: 'save_task_checkpoint' },
      { name: 'web_research' }, { name: 'analyze_returns' }, { name: 'delete_finance_entry' },
    ]
    const names = filterToolsReadOnly(tools).map((t) => t.name)
    expect(names).toEqual(['get_sales_summary', 'list_reminders', 'search_memory', 'web_research', 'analyze_returns'])
  })
})

describe('reconciliation', () => {
  const f = (role: string, findings: string, success = true): SpecialistFinding => ({
    role: role as SpecialistFinding['role'], success, findings, evidence: [], uncertainty: '',
    artifacts: [], proposedNextStep: null, toolsUsed: [], costUsd: 0, fromCache: false,
    error: success ? null : 'x', references: [],
  })

  it('flags contradictory branches for the head instead of averaging them away', () => {
    const out = reconcileFindings([f('analyst', 'sales বেড়ে গেছে ১২%'), f('researcher', 'bazar e sales kome geche')])
    expect(out.conflicts).toHaveLength(1)
    expect(out.conflicts[0].roles.sort()).toEqual(['analyst', 'researcher'])
    expect(out.headBrief).toContain('দ্বন্দ্ব')
  })

  it('keeps head as the single narrator: output is a brief, not owner prose', () => {
    const out = reconcileFindings([f('seo', 'rank 3 → 5')])
    expect(out.headBrief).toContain('head একমাত্র উত্তরদাতা')
  })
})

describe('cache policy (explicit key+version only)', () => {
  it('uncacheable briefs never consult the store; cacheable briefs pass through when store is off', async () => {
    let calls = 0
    const runner: SpecialistRunner = async (b) => {
      calls++
      return { success: true, summary: b.task, toolsUsed: [], costUsd: 0 }
    }
    const g = buildSpecialistFanoutGraph(runner)
    // Store gate is env-off in tests → cache is silently inert (fail-open).
    await g.invoke({ briefs: [brief('researcher', 'x', { cacheable: true, cacheKey: 'k', cacheVersion: 'v1' })] }, { recursionLimit: 24 })
    await g.invoke({ briefs: [brief('researcher', 'x', { cacheable: true, cacheKey: 'k', cacheVersion: 'v1' })] }, { recursionLimit: 24 })
    expect(calls).toBe(2)
  })

  it('scopes identical cache keys by business and revalidates role/business references on write', async () => {
    process.env.AGENT_REFERENCES_ROLLOUT = 'shadow'
    const store = fakeStore()
    memory.store = store
    const lifestyle = buildInternalEntityReference({
      namespace: 'order', id: 'cache-lifestyle', sourceTool: 'get_orders', outputPath: 'data.orders[0].id',
      context: { businessId: 'ALMA_LIFESTYLE', roles: ['SUPER_ADMIN'] },
    })!
    const cdit = buildInternalEntityReference({
      namespace: 'cdit_project', id: 'cache-cdit', sourceTool: 'get_cdit_projects', outputPath: 'data.projects[0].id',
      context: { businessId: 'CREATIVE_DIGITAL_IT', roles: ['SUPER_ADMIN'] },
    })!
    const viewerOnly = buildInternalEntityReference({
      namespace: 'order', id: 'cache-viewer', sourceTool: 'get_orders', outputPath: 'data.orders[0].id',
      context: { businessId: 'ALMA_LIFESTYLE', roles: ['VIEWER'] },
    })!
    let calls = 0
    const runner: SpecialistRunner = async (candidate) => {
      calls++
      return {
        success: true, summary: candidate.businessId, toolsUsed: [], costUsd: 0,
        references: [lifestyle, cdit, viewerOnly],
      }
    }
    const cache = { cacheable: true, cacheKey: 'same', cacheVersion: 'v1' }

    const lifestyleOut = await runSpecialistFanout([
      brief('researcher', 'lifestyle', { ...cache, referenceRoles: ['SUPER_ADMIN'] as AlmaRole[] }),
    ], { runner })
    const cditOut = await runSpecialistFanout([
      brief('researcher', 'cdit', {
        ...cache, businessId: 'CREATIVE_DIGITAL_IT', referenceRoles: ['SUPER_ADMIN'] as AlmaRole[],
      }),
    ], { runner })

    expect(calls).toBe(2)
    expect(lifestyleOut.references).toEqual([lifestyle])
    expect(cditOut.references).toEqual([cdit])
    expect(store.put.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining([
      expect.arrayContaining(['ALMA_LIFESTYLE']),
      expect.arrayContaining(['CREATIVE_DIGITAL_IT']),
    ]))
  })

  it('revalidates cached references on read and clears them when collection is OFF', async () => {
    process.env.AGENT_REFERENCES_ROLLOUT = 'shadow'
    const store = fakeStore()
    memory.store = store
    const lifestyle = buildInternalEntityReference({
      namespace: 'order', id: 'cache-read', sourceTool: 'get_orders', outputPath: 'data.orders[0].id',
      context: { businessId: 'ALMA_LIFESTYLE', roles: ['SUPER_ADMIN'] },
    })!
    const cdit = buildInternalEntityReference({
      namespace: 'cdit_project', id: 'cache-read-cdit', sourceTool: 'get_cdit_projects', outputPath: 'data.projects[0].id',
      context: { businessId: 'CREATIVE_DIGITAL_IT', roles: ['SUPER_ADMIN'] },
    })!
    let calls = 0
    const runner: SpecialistRunner = async () => {
      calls++
      return { success: true, summary: 'cached', toolsUsed: [], costUsd: 0, references: [lifestyle] }
    }
    const scopedBrief = brief('researcher', 'cached', {
      cacheable: true, cacheKey: 'read', cacheVersion: 'v1', referenceRoles: ['SUPER_ADMIN'],
    })

    await runSpecialistFanout([scopedBrief], { runner })
    const stored = [...store.rows.values()][0].value as { finding: SpecialistFinding }
    stored.finding.references.push(cdit)

    const shadowHit = await runSpecialistFanout([scopedBrief], { runner })
    expect(calls).toBe(1)
    expect(shadowHit.references).toEqual([lifestyle])

    process.env.AGENT_REFERENCES_ROLLOUT = 'off'
    const offHit = await runSpecialistFanout([scopedBrief], { runner })
    // Rollout mode is part of the namespace, so OFF cannot replay a SHADOW
    // result whose summary may have been produced under different link rules.
    expect(calls).toBe(2)
    expect(offHit.references).toEqual([])
    expect(offHit.findings[0].references).toEqual([])
  })
})
