/**
 * Phase 54 exit gates as tests:
 *   • forced worker kill at EVERY node boundary resumes from the next safe point
 *   • effect nodes are exactly-once across kill/resume (Phase 53 engine)
 *   • duplicate workers cannot hold the same lease
 *   • cancellation stops at a node boundary
 *   • persistent node failure pauses with the EXACT blocker; later retry resumes
 *   • owner-readable progress (goal, completed, current, next, blocker, ETA)
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'crypto'
import {
  acquireTaskLease,
  cancelDurableTask,
  clearTaskGraphs,
  createDurableTask,
  getTaskProgress,
  registerTaskGraph,
  replayTaskEvents,
  runDurableTask,
  type TaskDb,
  type TaskRunRow,
} from '@/agent/lib/graph/durable-task-graph'
import type { ActionRunRow, EffectDb, LedgerRow, OutboxRow } from '@/agent/lib/effects/effect-ledger'

// ── Fake TaskDb (WorkflowRun subset, snapshot-rollback transactions) ──────────

/* eslint-disable @typescript-eslint/no-explicit-any */
class FakeTaskDb implements TaskDb {
  runs: TaskRunRow[] = []
  events: Array<{ id: string; workflowRunId: string; toState: string; detail: unknown; ts: Date }> = []

  workflowRun = {
    create: async ({ data }: { data: any }): Promise<TaskRunRow> => {
      const row: TaskRunRow = {
        id: randomUUID(),
        conversationId: data.conversationId ?? null,
        businessId: data.businessId ?? 'ALMA_LIFESTYLE',
        kind: data.kind,
        goal: data.goal,
        status: data.status ?? 'active',
        state: data.state ?? 'queued',
        stateVersion: 1,
        inputs: data.inputs ?? null,
        facts: data.facts ?? null,
        artifacts: null,
        pendingActionId: null,
        retryCount: 0,
        leaseUntil: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: null,
      }
      this.runs.push(row)
      return { ...row }
    },
    findUnique: async ({ where }: { where: any }): Promise<TaskRunRow | null> => {
      const r = this.runs.find((x) => x.id === where.id)
      return r ? { ...r } : null
    },
    findMany: async (): Promise<TaskRunRow[]> => this.runs.map((r) => ({ ...r })),
    updateMany: async ({ where, data }: { where: any; data: any }): Promise<{ count: number }> => {
      let count = 0
      for (const r of this.runs) {
        if (where.id && r.id !== where.id) continue
        if (where.status && r.status !== where.status) continue
        if (where.stateVersion !== undefined && r.stateVersion !== where.stateVersion) continue
        if (where.OR) {
          const ok = (where.OR as any[]).some((c) => {
            if ('leaseUntil' in c) {
              if (c.leaseUntil === null) return r.leaseUntil === null
              if (c.leaseUntil?.lt) return r.leaseUntil !== null && r.leaseUntil < c.leaseUntil.lt
            }
            return false
          })
          if (!ok) continue
        }
        Object.assign(r, data, { updatedAt: new Date() })
        count += 1
      }
      return { count }
    },
  }

  workflowRunEvent = {
    create: async ({ data }: { data: any }) => {
      const row = { id: randomUUID(), workflowRunId: data.workflowRunId, toState: data.toState, detail: data.detail, ts: new Date() }
      this.events.push(row)
      return row
    },
    findMany: async (args: any = {}) => {
      let rows = this.events.filter((e) => !args.where?.workflowRunId || e.workflowRunId === args.where.workflowRunId)
      if (args.where?.ts?.gt) rows = rows.filter((e) => e.ts > args.where.ts.gt)
      return rows.map((r) => ({ ...r }))
    },
  }

  async $transaction<T>(fn: (tx: TaskDb) => Promise<T>): Promise<T> {
    const snap = { runs: this.runs.map((r) => ({ ...r })), events: this.events.map((e) => ({ ...e })) }
    try {
      return await fn(this)
    } catch (err) {
      this.runs = snap.runs
      this.events = snap.events
      throw err
    }
  }
}

/** Compact fake EffectDb — just enough for executeEffect. */
class FakeEffectDb implements EffectDb {
  runs: ActionRunRow[] = []
  ledgerRows: LedgerRow[] = []
  outboxRows: OutboxRow[] = []

  agentActionRun = {
    create: async ({ data }: { data: any }): Promise<ActionRunRow> => {
      if (this.runs.some((r) => r.idempotencyKey === data.idempotencyKey)) throw new Error('unique violation')
      const row = {
        id: randomUUID(), idempotencyKey: data.idempotencyKey, effectHash: data.effectHash, tool: data.tool,
        surface: data.surface ?? 'worker', actor: data.actor ?? 'agent', instructionOrigin: data.instructionOrigin ?? 'owner_policy',
        conversationId: data.conversationId ?? null, turnId: data.turnId ?? null, businessId: data.businessId ?? null,
        riskTier: data.riskTier, policyVersion: data.policyVersion, approvalRef: data.approvalRef ?? null,
        state: data.state ?? 'proposed', stateVersion: 1, attempts: 0, input: data.input,
        destination: data.destination ?? null, providerRef: null, proof: data.proof ?? null, result: null,
        costUsd: null, moneyTaka: null, error: null, compensationOfId: null, createdAt: new Date(), updatedAt: new Date(),
      } as ActionRunRow
      this.runs.push(row)
      return { ...row }
    },
    findUnique: async ({ where }: { where: any }) => {
      const r = where.id ? this.runs.find((x) => x.id === where.id) : this.runs.find((x) => x.idempotencyKey === where.idempotencyKey)
      return r ? { ...r } : null
    },
    findMany: async () => this.runs.map((r) => ({ ...r })),
    update: async ({ where, data }: any) => {
      const r = this.runs.find((x) => x.id === where.id)!
      Object.assign(r, data, { updatedAt: new Date() })
      return { ...r }
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0
      for (const r of this.runs) {
        if (where.id && r.id !== where.id) continue
        if (where.state && r.state !== where.state) continue
        if (where.stateVersion !== undefined && r.stateVersion !== where.stateVersion) continue
        Object.assign(r, data, { updatedAt: new Date() })
        count += 1
      }
      return { count }
    },
  }

  agentEffectLedger = {
    create: async ({ data }: any) => {
      if (this.ledgerRows.some((l) => l.runId === data.runId && l.seq === data.seq)) throw new Error('unique violation')
      const row = { id: randomUUID(), runId: data.runId, seq: data.seq, kind: data.kind, fromState: data.fromState ?? null, toState: data.toState ?? null, payload: data.payload ?? null, at: new Date() } as LedgerRow
      this.ledgerRows.push(row)
      return { ...row }
    },
    findMany: async (args: any = {}) => {
      let rows = this.ledgerRows.filter((l) => !args.where?.runId || l.runId === args.where.runId)
      if (args.orderBy?.seq === 'desc') rows = [...rows].sort((a, b) => b.seq - a.seq)
      if (args.orderBy?.seq === 'asc') rows = [...rows].sort((a, b) => a.seq - b.seq)
      if (args.take) rows = rows.slice(0, args.take)
      return rows.map((r) => ({ ...r }))
    },
  }

  agentEffectOutbox = {
    create: async ({ data }: any) => { const row = { id: randomUUID(), runId: data.runId, dueAt: data.dueAt ?? new Date(), leaseUntil: null, leaseOwner: null, attempts: 0, maxAttempts: data.maxAttempts ?? 5, createdAt: new Date() } as OutboxRow; this.outboxRows.push(row); return { ...row } },
    findMany: async () => this.outboxRows.map((r) => ({ ...r })),
    update: async ({ where, data }: any) => { const r = this.outboxRows.find((x) => x.id === where.id)!; Object.assign(r, data); return { ...r } },
    updateMany: async () => ({ count: 0 }),
    deleteMany: async ({ where }: any) => { const b = this.outboxRows.length; this.outboxRows = this.outboxRows.filter((r) => r.id !== where.id); return { count: b - this.outboxRows.length } },
  }

  async $transaction<T>(fn: (tx: EffectDb) => Promise<T>): Promise<T> {
    const snap = { runs: this.runs.map((r) => ({ ...r })), ledger: this.ledgerRows.map((r) => ({ ...r })) }
    try {
      return await fn(this)
    } catch (err) {
      this.runs = snap.runs
      this.ledgerRows = snap.ledger
      throw err
    }
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const NO_SLEEP = async () => {}

let db: FakeTaskDb
let effectDb: FakeEffectDb
let nodeExecutions: Record<string, number>

function countRun(id: string): void {
  nodeExecutions[id] = (nodeExecutions[id] ?? 0) + 1
}

beforeEach(() => {
  db = new FakeTaskDb()
  effectDb = new FakeEffectDb()
  nodeExecutions = {}
  clearTaskGraphs()
})

function registerThreeNodeGraph(opts: { failNode?: string; failTimes?: number } = {}): void {
  let failsLeft = opts.failTimes ?? Infinity
  registerTaskGraph({
    name: 'demo',
    goal: 'ডেমো লম্বা কাজ',
    nodes: [
      { id: 'n1', kind: 'read', label: 'ডেটা পড়া', estimateSec: 10, run: async () => { countRun('n1'); return { rows: 3 } } },
      {
        id: 'n2', kind: 'plan', label: 'পরিকল্পনা', estimateSec: 20,
        run: async () => {
          countRun('n2')
          if (opts.failNode === 'n2' && failsLeft > 0) { failsLeft -= 1; throw new Error('provider outage: research API down') }
          return { plan: 'ok' }
        },
      },
      { id: 'n3', kind: 'verify', label: 'যাচাই', estimateSec: 5, run: async (ctx) => { countRun('n3'); return { verified: ctx.outputs.n1 !== undefined } } },
    ],
  })
}

describe('graph registration', () => {
  it('rejects duplicate node ids and forward dependencies', () => {
    expect(() => registerTaskGraph({ name: 'bad', goal: 'x', nodes: [
      { id: 'a', kind: 'read', label: 'a', run: async () => null },
      { id: 'a', kind: 'read', label: 'a2', run: async () => null },
    ] })).toThrow(/duplicate/)
    expect(() => registerTaskGraph({ name: 'bad2', goal: 'x', nodes: [
      { id: 'a', kind: 'read', label: 'a', dependsOn: ['zz'], run: async () => null },
    ] })).toThrow(/depends on/)
  })
})

describe('happy path + checkpoints', () => {
  it('runs all nodes once, checkpoints each, finishes done', async () => {
    registerThreeNodeGraph()
    const run = await createDurableTask({ graph: 'demo', conversationId: 'c1' }, db)
    const result = await runDurableTask(run.id, { owner: 'w1', sleep: NO_SLEEP }, db)
    expect(result.status).toBe('done')
    expect(result.completed).toEqual(['n1', 'n2', 'n3'])
    expect(nodeExecutions).toEqual({ n1: 1, n2: 1, n3: 1 })
    const events = await replayTaskEvents(run.id, null, db)
    expect(events.length).toBeGreaterThanOrEqual(5) // queued + running + 3 checkpoints + finished
    const final = await db.workflowRun.findUnique({ where: { id: run.id } })
    expect(final?.status).toBe('done')
  })
})

describe('exit gate: forced kill at EVERY node boundary resumes from the next safe point', () => {
  it.each(['n1', 'n2', 'n3'])('kill right after %s checkpoint → resume completes without re-running any node', async (killNode) => {
    registerThreeNodeGraph()
    const run = await createDurableTask({ graph: 'demo' }, db)

    await expect(
      runDurableTask(run.id, {
        owner: 'w1',
        sleep: NO_SLEEP,
        afterNodeCheckpoint: (nodeId) => {
          if (nodeId === killNode) throw new Error('SIGKILL (simulated)')
        },
      }, db),
    ).rejects.toThrow('SIGKILL')

    // Lease is still held by the dead worker — a fresh worker takes over after expiry.
    const later = new Date(Date.now() + 10 * 60_000)
    const result = await runDurableTask(run.id, { owner: 'w2', sleep: NO_SLEEP, now: () => later }, db)
    expect(result.status).toBe('done')
    expect(result.completed).toEqual(['n1', 'n2', 'n3'])
    expect(nodeExecutions.n1).toBe(1)
    expect(nodeExecutions.n2).toBe(1)
    expect(nodeExecutions.n3).toBe(1)
  })
})

describe('exit gate: effect nodes are exactly-once across kill/resume', () => {
  it('effect dispatch happens once even when the worker dies right after its checkpoint', async () => {
    let sends = 0
    registerTaskGraph({
      name: 'effectful',
      goal: 'send + verify',
      nodes: [
        { id: 'prep', kind: 'read', label: 'প্রস্তুতি', run: async () => { countRun('prep'); return { ok: true } } },
        {
          id: 'send', kind: 'effect', label: 'মেসেজ পাঠানো',
          run: async (ctx) => {
            countRun('send')
            const outcome = await ctx.effect({
              tool: 'send_whatsapp',
              input: { to: 'x', message: 'হ্যালো' },
              riskTier: 'R3',
              execute: async () => { sends += 1; return { success: true, providerRef: 'wa-1' } },
            })
            if (!outcome.ok) throw new Error(outcome.error ?? 'effect failed')
            return { runId: outcome.runId }
          },
        },
        { id: 'after', kind: 'verify', label: 'পরে যাচাই', run: async () => { countRun('after'); return { done: true } } },
      ],
    })

    const run = await createDurableTask({ graph: 'effectful' }, db)
    await expect(
      runDurableTask(run.id, {
        owner: 'w1', sleep: NO_SLEEP, effectDb,
        afterNodeCheckpoint: (n) => { if (n === 'send') throw new Error('SIGKILL') },
      }, db),
    ).rejects.toThrow('SIGKILL')
    expect(sends).toBe(1)

    const later = new Date(Date.now() + 10 * 60_000)
    const result = await runDurableTask(run.id, { owner: 'w2', sleep: NO_SLEEP, effectDb, now: () => later }, db)
    expect(result.status).toBe('done')
    expect(sends).toBe(1) // no duplicate dispatch
    expect(nodeExecutions.send).toBe(1) // node body itself never re-ran (checkpointed)
  })

  it('a crash BEFORE the effect-node checkpoint still cannot duplicate the dispatch (idempotency key)', async () => {
    let sends = 0
    registerTaskGraph({
      name: 'effectful2',
      goal: 'x',
      nodes: [
        {
          id: 'send', kind: 'effect', label: 'পাঠানো',
          run: async (ctx) => {
            countRun('send')
            const outcome = await ctx.effect({
              tool: 'send_whatsapp',
              input: { to: 'y', message: 'আবার' },
              execute: async () => { sends += 1; return { success: true } },
            })
            // Simulate crash AFTER the effect engine committed but BEFORE the
            // graph checkpoint: first invocation throws post-effect.
            if (nodeExecutions.send === 1) throw new Error('crash after effect, before checkpoint')
            if (!outcome.ok && !outcome.replayed) throw new Error(outcome.error ?? 'failed')
            return { ok: true }
          },
        },
      ],
    })
    const run = await createDurableTask({ graph: 'effectful2' }, db)
    const first = await runDurableTask(run.id, { owner: 'w1', sleep: NO_SLEEP, effectDb }, db)
    expect(first.status).toBe('blocked') // node body failed post-effect

    const later = new Date(Date.now() + 10 * 60_000)
    const second = await runDurableTask(run.id, { owner: 'w2', sleep: NO_SLEEP, effectDb, now: () => later }, db)
    expect(second.status).toBe('done')
    expect(nodeExecutions.send).toBe(2) // node body re-ran…
    expect(sends).toBe(1) // …but the EFFECT did not (replayed from the engine)
  })
})

describe('exit gate: duplicate workers cannot hold the same lease', () => {
  it('second lease attempt fails while the first is live', async () => {
    registerThreeNodeGraph()
    const run = await createDurableTask({ graph: 'demo' }, db)
    const now = new Date()
    const first = await acquireTaskLease(run.id, { owner: 'w1', now }, db)
    expect(first).not.toBeNull()
    const second = await acquireTaskLease(run.id, { owner: 'w2', now }, db)
    expect(second).toBeNull()
    const afterExpiry = await acquireTaskLease(run.id, { owner: 'w2', now: new Date(now.getTime() + 10 * 60_000) }, db)
    expect(afterExpiry).not.toBeNull()
  })
})

describe('cancellation', () => {
  it('stops at the next node boundary; completed work is preserved', async () => {
    registerTaskGraph({
      name: 'cancellable',
      goal: 'x',
      nodes: [
        { id: 'n1', kind: 'read', label: 'এক', run: async () => { countRun('n1'); return 1 } },
        { id: 'n2', kind: 'read', label: 'দুই', run: async (ctx) => { countRun('n2'); await cancelDurableTask(ctx.runId, db); return 2 } },
        { id: 'n3', kind: 'read', label: 'তিন', run: async () => { countRun('n3'); return 3 } },
      ],
    })
    const run = await createDurableTask({ graph: 'cancellable' }, db)
    const result = await runDurableTask(run.id, { owner: 'w1', sleep: NO_SLEEP }, db)
    expect(result.status).toBe('cancelled')
    expect(nodeExecutions.n3).toBeUndefined()
    const final = await db.workflowRun.findUnique({ where: { id: run.id } })
    expect(final?.status).toBe('cancelled')
  })
})

describe('blockers + recovery (outage pauses with the exact blocker)', () => {
  it('persistent provider outage → blocked with the exact reason; later retry resumes from the failed node', async () => {
    registerThreeNodeGraph({ failNode: 'n2', failTimes: 3 }) // exhausts maxAttempts=3
    const run = await createDurableTask({ graph: 'demo' }, db)
    const result = await runDurableTask(run.id, { owner: 'w1', sleep: NO_SLEEP }, db)
    expect(result.status).toBe('blocked')
    expect(result.blocker).toContain('provider outage')

    const progress = await getTaskProgress(run.id, db)
    expect(progress?.blocker).toContain('provider outage')
    expect(progress?.completed.map((c) => c.id)).toEqual(['n1'])

    // Provider recovers → retry resumes from n2, never re-running n1.
    const later = new Date(Date.now() + 10 * 60_000)
    const retry = await runDurableTask(run.id, { owner: 'w1', sleep: NO_SLEEP, now: () => later }, db)
    expect(retry.status).toBe('done')
    expect(nodeExecutions.n1).toBe(1)
  })
})

describe('owner-readable progress', () => {
  it('reports goal, completed, current, next, ETA range', async () => {
    registerThreeNodeGraph()
    const run = await createDurableTask({ graph: 'demo' }, db)
    const before = await getTaskProgress(run.id, db)
    expect(before?.goal).toBe('ডেমো লম্বা কাজ')
    expect(before?.completed).toEqual([])
    expect(before?.current?.id).toBe('n1')
    expect(before?.next.map((n) => n.id)).toEqual(['n2', 'n3'])
    expect(before?.etaSecRange?.[0]).toBeGreaterThan(0)

    await runDurableTask(run.id, { owner: 'w1', sleep: NO_SLEEP }, db)
    const after = await getTaskProgress(run.id, db)
    expect(after?.status).toBe('done')
    expect(after?.completed.map((c) => c.id)).toEqual(['n1', 'n2', 'n3'])
    expect(after?.current).toBeNull()
    expect(after?.etaSecRange).toBeNull()
  })

  it('replayTaskEvents returns only events after the cursor (exactly-once reconnection)', async () => {
    registerThreeNodeGraph()
    const run = await createDurableTask({ graph: 'demo' }, db)
    await runDurableTask(run.id, { owner: 'w1', sleep: NO_SLEEP }, db)
    const all = await replayTaskEvents(run.id, null, db)
    expect(all.length).toBeGreaterThan(3)
    const mid = all[2].ts
    const rest = await replayTaskEvents(run.id, mid, db)
    expect(rest.length).toBe(all.filter((e) => e.ts > mid).length)
  })
})
