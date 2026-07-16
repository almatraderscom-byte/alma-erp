/**
 * Graph health readers — behaviour lock.
 *
 * Contracts: agree-rate/handled-share math from route spans, the canary
 * verdict thresholds (≥200 scored @ ≥98%), thread-family bucketing, and
 * fail-open on a broken DB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

interface SpanRow { detail: Record<string, unknown> }
let spans: SpanRow[] = []
let checkpointRows: Array<{ thread_id: string; n: bigint }> = []
let dbBroken = false

vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentToolEvent: {
      findMany: vi.fn(async () => {
        if (dbBroken) throw new Error('db down')
        return spans
      }),
    },
    $queryRaw: vi.fn(async () => {
      if (dbBroken) throw new Error('db down')
      return checkpointRows
    }),
  },
}))

import { getTurnGraphHealth, getCheckpointStoreHealth } from '../graph-health'

beforeEach(() => {
  spans = []
  checkpointRows = []
  dbBroken = false
})

function span(routineGraph: string, turnGraph: { fastPath?: string; agree?: boolean | null } | null, actionGraph = 'off'): SpanRow {
  return { detail: { routineGraph, actionGraph, turnGraph } }
}

describe('getTurnGraphHealth', () => {
  it('computes handled share, agree rate and per-kind buckets', async () => {
    spans = [
      span('handled', { fastPath: 'routine', agree: true }),
      span('handled', { fastPath: 'routine', agree: true }),
      span('miss', { fastPath: 'deny', agree: false }),
      span('off', { fastPath: 'continuation', agree: null }), // recorded, not scored
      span('off', null, 'staged'),
    ]
    const h = await getTurnGraphHealth(7)
    expect(h).not.toBeNull()
    expect(h!.turns).toBe(5)
    expect(h!.routine.handled).toBe(2)
    expect(h!.routine.miss).toBe(1)
    expect(h!.routine.handledShare).toBeCloseTo(2 / 3)
    expect(h!.action.staged).toBe(1)
    expect(h!.shadow.recorded).toBe(4)
    expect(h!.shadow.scored).toBe(3)
    expect(h!.shadow.agreeRate).toBeCloseTo(2 / 3)
    expect(h!.shadow.byKind.routine).toEqual({ scored: 2, agreed: 2 })
    expect(h!.canaryReady).toBe(false)
    expect(h!.canaryVerdict).toContain('NOT YET')
  })

  it('canary READY needs ≥200 scored turns at ≥98% agreement', async () => {
    spans = Array.from({ length: 210 }, (_v, i) =>
      span('off', { fastPath: 'deny', agree: i >= 2 }), // 208/210 ≈ 99%
    )
    const h = await getTurnGraphHealth(7)
    expect(h!.shadow.scored).toBe(210)
    expect(h!.canaryReady).toBe(true)
    expect(h!.canaryVerdict).toContain('READY')
  })

  it('fails open to null on a broken DB', async () => {
    dbBroken = true
    expect(await getTurnGraphHealth(7)).toBeNull()
  })
})

describe('getCheckpointStoreHealth', () => {
  it('buckets threads by family prefix', async () => {
    checkpointRows = [
      { thread_id: 'conv-123', n: BigInt(40) },
      { thread_id: 'wfstep:run1', n: BigInt(6) },
      { thread_id: 'wfrun:run1', n: BigInt(8) },
      { thread_id: 'lbrowse:conv-1', n: BigInt(12) },
      { thread_id: 'duty:heartbeat:2026-07-16', n: BigInt(30) },
      { thread_id: 'plan:plan-1', n: BigInt(5) },
    ]
    const s = await getCheckpointStoreHealth()
    expect(s).not.toBeNull()
    expect(s!.totalCheckpoints).toBe(101)
    expect(s!.totalThreads).toBe(6)
    expect(s!.threadFamilies).toEqual({ turn: 1, wfstep: 1, wfrun: 1, lbrowse: 1, duty: 1, plan: 1 })
  })

  it('fails open to null on a broken DB', async () => {
    dbBroken = true
    expect(await getCheckpointStoreHealth()).toBeNull()
  })
})
