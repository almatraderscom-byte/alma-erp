import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Phase 61 — production truth locks the two invariants the final roadmap
 * demands: (1) a missing/unconfigured capability NEVER reads green, and (2) a
 * probe failure degrades to `unknown` (red/amber), never to a false pass.
 */

// A mutable store the (hoisted) prisma mock reads from, so each test can shape
// the live DB truth without re-mocking.
const h = vi.hoisted(() => {
  const state: {
    counts: Record<string, number>
    firsts: Record<string, unknown>
    findMany: Record<string, unknown[]>
    queryRaw: unknown[]
    throwOn: Set<string>
  } = { counts: {}, firsts: {}, findMany: {}, queryRaw: [], throwOn: new Set() }

  const model = (name: string) => ({
    count: vi.fn(async () => {
      if (state.throwOn.has(`${name}.count`)) throw new Error('boom')
      return state.counts[name] ?? 0
    }),
    findFirst: vi.fn(async () => state.firsts[name] ?? null),
    findUnique: vi.fn(async () => state.firsts[`${name}.unique`] ?? null),
    findMany: vi.fn(async () => {
      if (state.throwOn.has(`${name}.findMany`)) throw new Error('boom')
      return state.findMany[name] ?? []
    }),
  })

  const prisma = new Proxy(
    { $queryRaw: vi.fn(async () => state.queryRaw) },
    {
      get(target, prop: string) {
        if (prop in target) return (target as Record<string, unknown>)[prop]
        return model(prop)
      },
    },
  )
  return { state, prisma }
})

vi.mock('@/lib/prisma', () => ({ prisma: h.prisma }))
vi.mock('@/lib/runtime-build', () => ({
  getBuildInfo: () => ({
    ok: true,
    environment: 'preview',
    commit: 'abc1234567890',
    commitShort: 'abc1234',
    message: 'test',
    branch: 'agent-phase-61',
    appUrl: 'https://example.test',
    githubCommitUrl: null,
    vercelDeploymentUrl: null,
    checkedAt: new Date().toISOString(),
  }),
}))

import { getProductionTruth, getReleaseIdentity } from '../production-truth'

const GREEN = 'live'

beforeEach(() => {
  h.state.counts = {}
  h.state.firsts = {}
  h.state.findMany = {}
  h.state.queryRaw = []
  h.state.throwOn = new Set()
})

describe('production truth — nothing configured', () => {
  it('renders no capability green when the DB is empty', async () => {
    const truth = await getProductionTruth()
    const green = truth.features.filter((f) => f.effectiveMode === GREEN)
    expect(green).toHaveLength(0)
  })

  it('reports the missing Growth Brief as off with a blocker, never live', async () => {
    const truth = await getProductionTruth()
    const brief = truth.features.find((f) => f.id === 'growth_brief')!
    expect(brief.effectiveMode).toBe('off')
    expect(brief.configured).toBe(false)
    expect(brief.blocker).toBeTruthy()
  })

  it('reflects the post-wiring reality: durable queue unwired, ladder shadow, adapters unused', async () => {
    const truth = await getProductionTruth()
    // Durable queue still has no production caller (Phase 65 worker follow-up).
    expect(truth.features.find((f) => f.id === 'durable_queue')!.effectiveMode).toBe('unwired')
    // Phase 64 wired the ladder into the guard → shadow (not unwired) until a
    // class is promoted.
    expect(truth.features.find((f) => f.id === 'autonomy_ladder')!.effectiveMode).toBe('shadow')
    // Phase 66 put the OS tools in the registry → reachable; no service
    // connected yet → unused (not unwired).
    expect(truth.features.find((f) => f.id === 'service_adapters')!.effectiveMode).toBe('unused')
  })

  it('marks Instagram unknown (provider truth unprovable read-only)', async () => {
    const truth = await getProductionTruth()
    expect(truth.features.find((f) => f.id === 'instagram')!.effectiveMode).toBe('unknown')
  })

  it('summary counts sum to the feature total', async () => {
    const truth = await getProductionTruth()
    const s = truth.summary
    const sum = s.live + s.shadow + s.off + s.unwired + s.broken + s.unused + s.unknown
    expect(sum).toBe(s.total)
    expect(s.total).toBe(truth.features.length)
  })
})

describe('production truth — probe failure degrades to unknown', () => {
  it('a throwing brief probe becomes unknown, not green', async () => {
    h.state.throwOn.add('agentGrowthBrief.count')
    const truth = await getProductionTruth()
    const brief = truth.features.find((f) => f.id === 'growth_brief')!
    expect(brief.effectiveMode).toBe('unknown')
    expect(brief.configured).toBe('unknown')
    expect(brief.effectiveMode).not.toBe(GREEN)
  })
})

describe('production truth — real records flip to live', () => {
  it('an approved Growth Brief reads live', async () => {
    h.state.counts.agentGrowthBrief = 1
    h.state.firsts.agentGrowthBrief = { version: 3, approvedAt: new Date() }
    const truth = await getProductionTruth()
    const brief = truth.features.find((f) => f.id === 'growth_brief')!
    expect(brief.effectiveMode).toBe('live')
    expect(brief.configured).toBe(true)
    expect(brief.blocker).toBeNull()
  })

  it('recent heartbeats read live', async () => {
    h.state.findMany.agentHeartbeat = [{ service: 'app-health', lastBeatAt: new Date() }]
    const truth = await getProductionTruth()
    expect(truth.features.find((f) => f.id === 'heartbeat')!.effectiveMode).toBe('live')
  })
})

describe('release identity', () => {
  it('proves the SHA when a commit is present', async () => {
    const rel = await getReleaseIdentity()
    expect(rel.shaProven).toBe(true)
    expect(rel.app.commitShort).toBe('abc1234')
  })

  it('reports migration head as unknown when the table read yields nothing', async () => {
    const rel = await getReleaseIdentity()
    expect(rel.migrationHead).toBe('unknown')
  })
})
