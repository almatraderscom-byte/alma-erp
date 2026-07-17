/**
 * Phase 53 exit gates as tests:
 *   • crash at every state boundary + repeat the request 20 times ⇒ EXACTLY ONE
 *     external effect
 *   • provider timeout-after-success is reconciled, not duplicated
 *   • ledger failure blocks the write (nothing dispatched)
 *   • ledger is complete for every effect; no success without proof
 *   • compensation is a new guarded effect
 *
 * The engine takes a structural EffectDb — tests inject an in-memory fake with
 * snapshot-rollback transactions (throw inside a tx ⇒ nothing persisted).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'crypto'
import type { ActionRunRow, EffectDb, LedgerRow, OutboxRow } from '@/agent/lib/effects/effect-ledger'
import { getLedgerChain, verifyLedgerCompleteness } from '@/agent/lib/effects/effect-ledger'
import {
  approveActionRun,
  assertLegalTransition,
  executeEffect,
  LEGAL_TRANSITIONS,
  transitionActionRun,
} from '@/agent/lib/effects/action-run'
import { completeOutboxItem, computeBackoffMs, enqueueEffectDispatch, failOutboxItem, leaseDueOutbox } from '@/agent/lib/effects/outbox'
import { clearReconcileProbes, reconcileStaleRuns, registerReconcileProbe } from '@/agent/lib/effects/reconciler'
import { compensateEffect } from '@/agent/lib/effects/compensation'
import { buildActionEnvelope, signEnvelope, type SignedEnvelope } from '@/agent/lib/policy/capability-token'

// ── In-memory fake DB with transactional snapshot-rollback ────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
class FakeDb implements EffectDb {
  runs: ActionRunRow[] = []
  ledgerRows: LedgerRow[] = []
  outboxRows: OutboxRow[] = []
  /** When set, the next ledger create throws (simulates ledger outage). */
  failNextLedgerCreate = false

  agentActionRun = {
    create: async ({ data }: { data: any }): Promise<ActionRunRow> => {
      if (this.runs.some((r) => r.idempotencyKey === data.idempotencyKey)) {
        throw new Error('unique constraint: idempotency_key')
      }
      const row: ActionRunRow = {
        id: data.id ?? randomUUID(),
        idempotencyKey: data.idempotencyKey,
        effectHash: data.effectHash,
        tool: data.tool,
        surface: data.surface ?? 'owner',
        actor: data.actor ?? 'owner',
        instructionOrigin: data.instructionOrigin ?? 'owner_direct',
        conversationId: data.conversationId ?? null,
        turnId: data.turnId ?? null,
        businessId: data.businessId ?? null,
        riskTier: data.riskTier,
        policyVersion: data.policyVersion,
        approvalRef: data.approvalRef ?? null,
        state: data.state ?? 'proposed',
        stateVersion: data.stateVersion ?? 1,
        attempts: data.attempts ?? 0,
        input: data.input,
        destination: data.destination ?? null,
        providerRef: data.providerRef ?? null,
        proof: data.proof ?? null,
        result: data.result ?? null,
        costUsd: data.costUsd ?? null,
        moneyTaka: data.moneyTaka ?? null,
        error: data.error ?? null,
        compensationOfId: data.compensationOfId ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      this.runs.push(row)
      return { ...row }
    },
    findUnique: async ({ where }: { where: any }): Promise<ActionRunRow | null> => {
      const row = where.id
        ? this.runs.find((r) => r.id === where.id)
        : this.runs.find((r) => r.idempotencyKey === where.idempotencyKey)
      return row ? { ...row } : null
    },
    findMany: async (args: any = {}): Promise<ActionRunRow[]> => {
      let rows = [...this.runs]
      const where = args.where ?? {}
      if (where.OR) {
        rows = rows.filter((r) =>
          (where.OR as any[]).some((cond) => {
            if (cond.state && r.state !== cond.state) return false
            if (cond.updatedAt?.lt && !(r.updatedAt < cond.updatedAt.lt)) return false
            return true
          }),
        )
      } else if (where.state) {
        rows = rows.filter((r) => r.state === where.state)
      }
      if (args.orderBy?.updatedAt === 'asc') rows.sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
      if (args.take) rows = rows.slice(0, args.take)
      return rows.map((r) => ({ ...r }))
    },
    update: async ({ where, data }: { where: any; data: any }): Promise<ActionRunRow> => {
      const row = this.runs.find((r) => r.id === where.id)
      if (!row) throw new Error('not found')
      Object.assign(row, data, { updatedAt: new Date() })
      return { ...row }
    },
    updateMany: async ({ where, data }: { where: any; data: any }): Promise<{ count: number }> => {
      let count = 0
      for (const row of this.runs) {
        if (where.id && row.id !== where.id) continue
        if (where.state && row.state !== where.state) continue
        if (where.stateVersion !== undefined && row.stateVersion !== where.stateVersion) continue
        Object.assign(row, data, { updatedAt: new Date() })
        count += 1
      }
      return { count }
    },
  }

  agentEffectLedger = {
    create: async ({ data }: { data: any }): Promise<LedgerRow> => {
      if (this.failNextLedgerCreate) {
        this.failNextLedgerCreate = false
        throw new Error('simulated ledger outage')
      }
      if (this.ledgerRows.some((l) => l.runId === data.runId && l.seq === data.seq)) {
        throw new Error('unique constraint: run_id+seq')
      }
      const row: LedgerRow = {
        id: randomUUID(),
        runId: data.runId,
        seq: data.seq,
        kind: data.kind,
        fromState: data.fromState ?? null,
        toState: data.toState ?? null,
        payload: data.payload ?? null,
        at: new Date(),
      }
      this.ledgerRows.push(row)
      return { ...row }
    },
    findMany: async (args: any = {}): Promise<LedgerRow[]> => {
      let rows = this.ledgerRows.filter((l) => !args.where?.runId || l.runId === args.where.runId)
      if (args.orderBy?.seq === 'desc') rows = [...rows].sort((a, b) => b.seq - a.seq)
      if (args.orderBy?.seq === 'asc') rows = [...rows].sort((a, b) => a.seq - b.seq)
      if (args.take) rows = rows.slice(0, args.take)
      return rows.map((r) => ({ ...r }))
    },
  }

  agentEffectOutbox = {
    create: async ({ data }: { data: any }): Promise<OutboxRow> => {
      const row: OutboxRow = {
        id: randomUUID(),
        runId: data.runId,
        dueAt: data.dueAt ?? new Date(),
        leaseUntil: null,
        leaseOwner: null,
        attempts: 0,
        maxAttempts: data.maxAttempts ?? 5,
        createdAt: new Date(),
      }
      this.outboxRows.push(row)
      return { ...row }
    },
    findMany: async (args: any = {}): Promise<OutboxRow[]> => {
      let rows = [...this.outboxRows]
      if (args.where?.dueAt?.lte) rows = rows.filter((r) => r.dueAt <= args.where.dueAt.lte)
      if (args.orderBy?.dueAt === 'asc') rows.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())
      if (args.take) rows = rows.slice(0, args.take)
      return rows.map((r) => ({ ...r }))
    },
    update: async ({ where, data }: { where: any; data: any }): Promise<OutboxRow> => {
      const row = this.outboxRows.find((r) => r.id === where.id)
      if (!row) throw new Error('not found')
      Object.assign(row, data)
      return { ...row }
    },
    updateMany: async ({ where, data }: { where: any; data: any }): Promise<{ count: number }> => {
      let count = 0
      for (const row of this.outboxRows) {
        if (where.id && row.id !== where.id) continue
        if ('leaseUntil' in where) {
          const expected = where.leaseUntil
          const matches = expected === null ? row.leaseUntil === null : row.leaseUntil?.getTime() === expected?.getTime()
          if (!matches) continue
        }
        Object.assign(row, data)
        count += 1
      }
      return { count }
    },
    deleteMany: async ({ where }: { where: any }): Promise<{ count: number }> => {
      const before = this.outboxRows.length
      this.outboxRows = this.outboxRows.filter((r) => r.id !== where.id)
      return { count: before - this.outboxRows.length }
    },
  }

  async $transaction<T>(fn: (tx: EffectDb) => Promise<T>): Promise<T> {
    const snapshot = {
      runs: this.runs.map((r) => ({ ...r })),
      ledger: this.ledgerRows.map((r) => ({ ...r })),
      outbox: this.outboxRows.map((r) => ({ ...r })),
    }
    try {
      return await fn(this)
    } catch (err) {
      this.runs = snapshot.runs
      this.ledgerRows = snapshot.ledger
      this.outboxRows = snapshot.outbox
      throw err
    }
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function makeEnvelope(tool: string, input: Record<string, unknown>, turnId = 'turn-1'): SignedEnvelope {
  return signEnvelope(
    buildActionEnvelope({
      actor: 'owner',
      surface: 'owner',
      instructionOrigin: 'owner_direct',
      tool,
      input,
      riskTier: 'R2',
      turnId,
      conversationId: 'conv-1',
      now: 1_752_700_000_000,
    }),
  )
}

let db: FakeDb
beforeEach(() => {
  db = new FakeDb()
  clearReconcileProbes()
})

describe('state machine', () => {
  it('declares every state and rejects illegal transitions', () => {
    expect(Object.keys(LEGAL_TRANSITIONS).sort()).toEqual(
      [
        'proposed', 'policy_checked', 'awaiting_approval', 'claimed', 'executing', 'verifying', 'succeeded',
        'denied', 'expired', 'failed_retryable', 'failed_final', 'unknown_effect', 'compensating', 'compensated',
      ].sort(),
    )
    expect(() => assertLegalTransition('succeeded', 'executing')).toThrow()
    expect(() => assertLegalTransition('denied', 'claimed')).toThrow()
    expect(() => assertLegalTransition('claimed', 'executing')).not.toThrow()
  })
})

describe('exactly-once execution', () => {
  it('20 identical requests ⇒ exactly one external effect, replays afterwards', async () => {
    let executions = 0
    const envelope = makeEnvelope('send_whatsapp', { to: 'x', message: 'hi' })
    for (let i = 0; i < 20; i += 1) {
      const outcome = await executeEffect({
        envelope,
        input: { to: 'x', message: 'hi' },
        execute: async () => {
          executions += 1
          return { success: true, data: { sent: true }, providerRef: 'msg-123' }
        },
        db,
      })
      expect(outcome.ok).toBe(true)
      expect(outcome.state).toBe('succeeded')
      if (i > 0) expect(outcome.replayed).toBe(true)
    }
    expect(executions).toBe(1)
    expect(db.runs).toHaveLength(1)
    expect(await verifyLedgerCompleteness(db.runs[0].id, db)).toEqual([])
  })

  it('crash at every pre-dispatch boundary then 20 retries ⇒ exactly one effect', async () => {
    // Boundary: crash INSIDE the intent transaction (ledger outage) — nothing persists.
    let executions = 0
    const envelope = makeEnvelope('send_whatsapp', { to: 'x', message: 'boundary' })
    db.failNextLedgerCreate = true
    await expect(
      executeEffect({ envelope, input: { to: 'x', message: 'boundary' }, execute: async () => { executions += 1; return { success: true } }, db }),
    ).rejects.toThrow('simulated ledger outage')
    expect(executions).toBe(0)
    expect(db.runs).toHaveLength(0) // rollback — the write was blocked

    // Boundaries: process died AFTER commit in each safe pre-dispatch state.
    for (const seededState of ['proposed', 'policy_checked', 'claimed'] as const) {
      const d = new FakeDb()
      let execs = 0
      const env2 = makeEnvelope('send_whatsapp', { to: 'x', message: `crash-${seededState}` }, `turn-${seededState}`)
      await d.agentActionRun.create({
        data: {
          idempotencyKey: env2.envelope.idempotencyKey,
          effectHash: env2.envelope.inputHash,
          tool: 'send_whatsapp',
          riskTier: 'R3',
          policyVersion: 'p52.1',
          state: seededState,
          input: { to: 'x' },
        },
      })
      await d.agentEffectLedger.create({ data: { runId: d.runs[0].id, seq: 1, kind: 'transition', toState: seededState } })
      for (let i = 0; i < 20; i += 1) {
        await executeEffect({
          envelope: env2,
          input: { to: 'x', message: `crash-${seededState}` },
          execute: async () => { execs += 1; return { success: true, providerRef: 'p-1' } },
          db: d,
        })
      }
      expect(execs, `state ${seededState}`).toBe(1)
      expect(d.runs[0].state).toBe('succeeded')
    }
  })

  it('crash AFTER dispatch (executing) NEVER blind-retries — reconcile decides', async () => {
    // Seed a run that crashed mid-dispatch.
    const envelope = makeEnvelope('send_whatsapp', { to: 'x', message: 'mid' })
    await db.agentActionRun.create({
      data: {
        idempotencyKey: envelope.envelope.idempotencyKey,
        effectHash: envelope.envelope.inputHash,
        tool: 'send_whatsapp',
        riskTier: 'R3',
        policyVersion: 'p52.1',
        state: 'executing',
        attempts: 1,
        input: { to: 'x' },
      },
    })
    await db.agentEffectLedger.create({ data: { runId: db.runs[0].id, seq: 1, kind: 'transition', toState: 'executing' } })

    let executions = 0
    // No reconcile probe: 20 retries stay unknown, executor NEVER runs.
    for (let i = 0; i < 20; i += 1) {
      const outcome = await executeEffect({
        envelope,
        input: { to: 'x', message: 'mid' },
        execute: async () => { executions += 1; return { success: true } },
        db,
      })
      expect(outcome.ok).toBe(false)
      expect(outcome.state).toBe('unknown_effect')
    }
    expect(executions).toBe(0)

    // Provider says NOT executed → exactly one retry executes.
    const final = await executeEffect({
      envelope,
      input: { to: 'x', message: 'mid' },
      execute: async () => { executions += 1; return { success: true, providerRef: 'p-9' } },
      reconcile: async () => 'not_executed',
      db,
    })
    expect(final.ok).toBe(true)
    expect(executions).toBe(1)
  })

  it('provider timeout-after-success is reconciled, not duplicated', async () => {
    let sends = 0
    const envelope = makeEnvelope('send_whatsapp', { to: 'x', message: 'timeout' })
    const outcome = await executeEffect({
      envelope,
      input: { to: 'x', message: 'timeout' },
      execute: async () => {
        sends += 1 // the provider RECEIVED it…
        throw new Error('ETIMEDOUT') // …but we never saw the response
      },
      reconcile: async () => 'succeeded', // authoritative provider state
      db,
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.state).toBe('succeeded')
    expect(sends).toBe(1) // no duplicate send
    const chain = await getLedgerChain(db.runs[0].id, db)
    expect(chain.some((r) => r.kind === 'proof')).toBe(true)
  })

  it('retryable failures re-execute; final failures replay without re-executing', async () => {
    let calls = 0
    const envelope = makeEnvelope('send_whatsapp', { to: 'x', message: 'retry' })
    const first = await executeEffect({
      envelope,
      input: { to: 'x', message: 'retry' },
      execute: async () => { calls += 1; return { success: false, error: 'rate limited', retryable: true } },
      db,
    })
    expect(first.state).toBe('failed_retryable')
    const second = await executeEffect({
      envelope,
      input: { to: 'x', message: 'retry' },
      execute: async () => { calls += 1; return { success: false, error: 'invalid recipient', retryable: false } },
      db,
    })
    expect(second.state).toBe('failed_final')
    const third = await executeEffect({
      envelope,
      input: { to: 'x', message: 'retry' },
      execute: async () => { calls += 1; return { success: true } },
      db,
    })
    expect(third.state).toBe('failed_final')
    expect(third.replayed).toBe(true)
    expect(calls).toBe(2)
  })

  it('no success without proof: demanded verify returning null keeps the run in verifying', async () => {
    const envelope = makeEnvelope('send_whatsapp', { to: 'x', message: 'proof' })
    const outcome = await executeEffect({
      envelope,
      input: { to: 'x', message: 'proof' },
      execute: async () => ({ success: true, providerRef: 'p-1' }),
      verify: async () => null, // independent postcondition unavailable
      db,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.state).toBe('verifying')
    expect(db.runs[0].state).toBe('verifying')

    // Later the postcondition read works → success with proof.
    const again = await executeEffect({
      envelope,
      input: { to: 'x', message: 'proof' },
      execute: async () => ({ success: true }),
      verify: async () => ({ kind: 'thread_reread', found: true }),
      db,
    })
    expect(again.ok).toBe(true)
    expect(await verifyLedgerCompleteness(db.runs[0].id, db)).toEqual([])
  })

  it('awaiting_approval holds the effect until approved', async () => {
    let executions = 0
    const envelope = makeEnvelope('send_whatsapp', { to: 'x', message: 'appr' })
    const held = await executeEffect({
      envelope,
      input: { to: 'x', message: 'appr' },
      execute: async () => { executions += 1; return { success: true } },
      requiresApproval: true,
      db,
    })
    expect(held.state).toBe('awaiting_approval')
    expect(executions).toBe(0)

    const approved = await approveActionRun(held.runId, 'card-77', db)
    expect(approved?.state).toBe('claimed')

    const done = await executeEffect({
      envelope,
      input: { to: 'x', message: 'appr' },
      execute: async () => { executions += 1; return { success: true } },
      db,
    })
    expect(done.ok).toBe(true)
    expect(executions).toBe(1)
    expect(db.runs[0].approvalRef).toBe('card-77')
  })
})

describe('outbox', () => {
  it('backoff is deterministic and capped', () => {
    expect(computeBackoffMs(1)).toBe(15_000)
    expect(computeBackoffMs(2)).toBe(30_000)
    expect(computeBackoffMs(3)).toBe(60_000)
    expect(computeBackoffMs(10)).toBe(300_000)
    expect(computeBackoffMs(50)).toBe(300_000)
  })

  it('enqueue is transactional with the run; lease is exclusive; dead-letter marks failed_final with ledger', async () => {
    const envelope = makeEnvelope('send_whatsapp', { to: 'x', message: 'outbox' })
    const run = await db.$transaction(async (tx) => {
      const r = await tx.agentActionRun.create({
        data: {
          idempotencyKey: envelope.envelope.idempotencyKey,
          effectHash: envelope.envelope.inputHash,
          tool: 'send_whatsapp',
          riskTier: 'R3',
          policyVersion: 'p52.1',
          state: 'claimed',
          input: { to: 'x' },
        },
      })
      await tx.agentEffectLedger.create({ data: { runId: r.id, seq: 1, kind: 'transition', toState: 'claimed' } })
      await enqueueEffectDispatch(tx, r.id)
      return r
    })

    const now = new Date()
    const lease1 = await leaseDueOutbox(db, { owner: 'w1', now })
    expect(lease1.leased).toHaveLength(1)
    const lease2 = await leaseDueOutbox(db, { owner: 'w2', now })
    expect(lease2.leased).toHaveLength(0) // duplicate workers cannot hold the same lease

    // Fail past maxAttempts → dead-letter.
    let row = { ...lease1.leased[0], attempts: 5 }
    const dead = await failOutboxItem(db, row, { error: 'provider down', now })
    expect(dead.deadLettered).toBe(true)
    expect(db.outboxRows).toHaveLength(0)
    const fresh = await db.agentActionRun.findUnique({ where: { id: run.id } })
    expect(fresh?.state).toBe('failed_final')
    const chain = await getLedgerChain(run.id, db)
    expect(chain.some((r) => r.payload && (r.payload as { deadLetter?: boolean }).deadLetter)).toBe(true)
  })

  it('completeOutboxItem removes the row', async () => {
    const envelope = makeEnvelope('send_whatsapp', { to: 'y', message: 'done' }, 'turn-ob2')
    await db.$transaction(async (tx) => {
      const r = await tx.agentActionRun.create({
        data: {
          idempotencyKey: envelope.envelope.idempotencyKey,
          effectHash: envelope.envelope.inputHash,
          tool: 'send_whatsapp',
          riskTier: 'R3',
          policyVersion: 'p52.1',
          state: 'claimed',
          input: {},
        },
      })
      await tx.agentEffectLedger.create({ data: { runId: r.id, seq: 1, kind: 'transition', toState: 'claimed' } })
      await enqueueEffectDispatch(tx, r.id)
    })
    const { leased } = await leaseDueOutbox(db, { owner: 'w1' })
    await completeOutboxItem(db, leased[0].id)
    expect(db.outboxRows).toHaveLength(0)
  })
})

describe('reconciler sweep', () => {
  it('stale executing runs move to unknown then resolve via the registered probe', async () => {
    const envelope = makeEnvelope('send_whatsapp', { to: 'x', message: 'sweep' })
    const old = new Date(Date.now() - 60 * 60_000)
    await db.agentActionRun.create({
      data: {
        idempotencyKey: envelope.envelope.idempotencyKey,
        effectHash: envelope.envelope.inputHash,
        tool: 'send_whatsapp',
        riskTier: 'R3',
        policyVersion: 'p52.1',
        state: 'executing',
        input: {},
      },
    })
    db.runs[0].updatedAt = old
    await db.agentEffectLedger.create({ data: { runId: db.runs[0].id, seq: 1, kind: 'transition', toState: 'executing' } })

    registerReconcileProbe('send_whatsapp', async () => 'succeeded')
    const sweep = await reconcileStaleRuns({ db, staleMs: 10 * 60_000 })
    expect(sweep.scanned).toBe(1)
    expect(sweep.resolved).toBe(1)
    expect(db.runs[0].state).toBe('succeeded')
    expect(await verifyLedgerCompleteness(db.runs[0].id, db)).toEqual([])
  })

  it('without a probe the run stays unknown — never blind-retried', async () => {
    const envelope = makeEnvelope('send_whatsapp', { to: 'x', message: 'noprobe' })
    await db.agentActionRun.create({
      data: {
        idempotencyKey: envelope.envelope.idempotencyKey,
        effectHash: envelope.envelope.inputHash,
        tool: 'send_whatsapp',
        riskTier: 'R3',
        policyVersion: 'p52.1',
        state: 'unknown_effect',
        input: {},
      },
    })
    await db.agentEffectLedger.create({ data: { runId: db.runs[0].id, seq: 1, kind: 'transition', toState: 'unknown_effect' } })
    const sweep = await reconcileStaleRuns({ db })
    expect(sweep.stillUnknown).toBe(1) // honestly still unknown
    expect(sweep.results[0].verdict).toBe('no_probe')
    expect(db.runs[0].state).toBe('unknown_effect')
  })
})

describe('compensation', () => {
  it('undo is a NEW ledgered effect; original goes compensating → compensated', async () => {
    // Succeed an effect first.
    const envelope = makeEnvelope('schedule_content', { postId: 'p1' })
    const done = await executeEffect({
      envelope,
      input: { postId: 'p1' },
      execute: async () => ({ success: true, providerRef: 'cal-1' }),
      db,
    })
    expect(done.ok).toBe(true)
    const original = (await db.agentActionRun.findUnique({ where: { id: done.runId } }))!

    let undone = 0
    const result = await compensateEffect({
      run: original,
      undo: {
        tool: 'cancel_scheduled_content',
        input: { postId: 'p1' },
        execute: async () => { undone += 1; return { success: true, providerRef: 'cal-1-cancel' } },
      },
      db,
    })
    expect(result.ok).toBe(true)
    expect(undone).toBe(1)

    const fresh = await db.agentActionRun.findUnique({ where: { id: original.id } })
    expect(fresh?.state).toBe('compensated')
    const undoRun = db.runs.find((r) => r.compensationOfId === original.id)
    expect(undoRun).toBeDefined()
    expect(undoRun?.state).toBe('succeeded')
    expect(await verifyLedgerCompleteness(undoRun!.id, db)).toEqual([])
  })

  it('failed undo leaves the original honestly in compensating', async () => {
    const envelope = makeEnvelope('schedule_content', { postId: 'p2' }, 'turn-c2')
    const done = await executeEffect({ envelope, input: { postId: 'p2' }, execute: async () => ({ success: true }), db })
    const original = (await db.agentActionRun.findUnique({ where: { id: done.runId } }))!
    const result = await compensateEffect({
      run: original,
      undo: {
        tool: 'cancel_scheduled_content',
        input: { postId: 'p2' },
        execute: async () => ({ success: false, error: 'already published', retryable: false }),
      },
      db,
    })
    expect(result.ok).toBe(false)
    expect((await db.agentActionRun.findUnique({ where: { id: original.id } }))?.state).toBe('compensating')
  })
})

describe('optimistic concurrency', () => {
  it('a stale stateVersion loses the compare-and-swap', async () => {
    const envelope = makeEnvelope('send_whatsapp', { to: 'x', message: 'cas' })
    const run = await db.agentActionRun.create({
      data: {
        idempotencyKey: envelope.envelope.idempotencyKey,
        effectHash: envelope.envelope.inputHash,
        tool: 'send_whatsapp',
        riskTier: 'R3',
        policyVersion: 'p52.1',
        state: 'claimed',
        input: {},
      },
    })
    await db.agentEffectLedger.create({ data: { runId: run.id, seq: 1, kind: 'transition', toState: 'claimed' } })
    const winner = await transitionActionRun(db, run, 'executing', {})
    expect(winner?.state).toBe('executing')
    const loser = await transitionActionRun(db, run, 'executing', {}) // stale version
    expect(loser).toBeNull()
  })
})
