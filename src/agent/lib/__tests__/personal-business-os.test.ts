/**
 * Phase 56 exit gate: at least one personal AND one business adapter complete
 * the FULL plan → guard → effect → verify → resume flow; cross-service tasks
 * keep one focus and never leak account scope.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'crypto'
import { makePersonalRecordsAdapter, makeMemoryPersonalStore } from '@/agent/lib/personal-os'
import { makeErpOrdersAdapter, makeMemoryOrdersStore } from '@/agent/lib/business-os'
import type { AdapterWriteContext } from '@/agent/lib/integrations/service-adapter'
import { decideActionPolicy } from '@/agent/lib/policy/action-policy'
import { buildActionEnvelope, signEnvelope } from '@/agent/lib/policy/capability-token'
import { executeEffect } from '@/agent/lib/effects/action-run'
import type { ActionRunRow, EffectDb, LedgerRow, OutboxRow } from '@/agent/lib/effects/effect-ledger'
import { verifyLedgerCompleteness } from '@/agent/lib/effects/effect-ledger'

// Compact fake EffectDb (same shape as effect-engine tests).
/* eslint-disable @typescript-eslint/no-explicit-any */
class FakeEffectDb implements EffectDb {
  runs: ActionRunRow[] = []
  ledgerRows: LedgerRow[] = []
  outboxRows: OutboxRow[] = []
  agentActionRun = {
    create: async ({ data }: any): Promise<ActionRunRow> => {
      if (this.runs.some((r) => r.idempotencyKey === data.idempotencyKey)) throw new Error('unique violation')
      const row = {
        id: randomUUID(), idempotencyKey: data.idempotencyKey, effectHash: data.effectHash, tool: data.tool,
        surface: data.surface ?? 'owner', actor: data.actor ?? 'owner', instructionOrigin: data.instructionOrigin ?? 'owner_direct',
        conversationId: data.conversationId ?? null, turnId: data.turnId ?? null, businessId: data.businessId ?? null,
        riskTier: data.riskTier, policyVersion: data.policyVersion, approvalRef: data.approvalRef ?? null,
        state: data.state ?? 'proposed', stateVersion: 1, attempts: data.attempts ?? 0, input: data.input,
        destination: data.destination ?? null, providerRef: null, proof: data.proof ?? null, result: null,
        costUsd: null, moneyTaka: null, error: null, compensationOfId: null, createdAt: new Date(), updatedAt: new Date(),
      } as ActionRunRow
      this.runs.push(row)
      return { ...row }
    },
    findUnique: async ({ where }: any) => {
      const r = where.id ? this.runs.find((x) => x.id === where.id) : this.runs.find((x) => x.idempotencyKey === where.idempotencyKey)
      return r ? { ...r } : null
    },
    findMany: async () => this.runs.map((r) => ({ ...r })),
    update: async ({ where, data }: any) => { const r = this.runs.find((x) => x.id === where.id)!; Object.assign(r, data, { updatedAt: new Date() }); return { ...r } },
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
    create: async ({ data }: any): Promise<LedgerRow> => {
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
    create: async ({ data }: any): Promise<OutboxRow> => { const row = { id: randomUUID(), runId: data.runId, dueAt: new Date(), leaseUntil: null, leaseOwner: null, attempts: 0, maxAttempts: 5, createdAt: new Date() } as OutboxRow; this.outboxRows.push(row); return { ...row } },
    findMany: async () => [],
    update: async ({ where }: any) => this.outboxRows.find((x) => x.id === where.id)!,
    updateMany: async () => ({ count: 0 }),
    deleteMany: async () => ({ count: 0 }),
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

/**
 * The OS write context: plan (policy core) → guard decision → effect engine →
 * verify → outcome. One conversation focus, one turn binding.
 */
function makeWriteContext(effectDb: FakeEffectDb, focus: { conversationId: string; turnId: string }): AdapterWriteContext {
  return {
    runEffect: async (opts) => {
      // GUARD: the pure policy core authorizes an owner_policy R1 reversible write.
      const decision = decideActionPolicy({
        tool: opts.tool,
        mode: 'write',
        risk: opts.riskTier === 'R1' ? 'low' : opts.riskTier === 'R2' ? 'medium' : 'high',
        domain: 'personal',
        instructionOrigin: 'owner_policy',
        ownerTurnAuthorizesMutation: true,
        policyEnabled: true,
        moneyTaka: 0,
        moneyCapTaka: 0,
        reversible: true,
        confidence: 1,
        duplicateOfPriorEffect: false,
        approvalPayloadChanged: false,
        capabilityRevoked: false,
        accountScopeOk: true,
      })
      if (decision.decision === 'deny') {
        return { ok: false, state: 'denied', runId: 'guard', replayed: false, error: decision.reasonBn, errorCode: 'effect_denied' }
      }
      const envelope = signEnvelope(
        buildActionEnvelope({
          actor: 'agent',
          surface: 'worker',
          instructionOrigin: 'owner_policy',
          tool: opts.tool,
          input: opts.input,
          riskTier: opts.riskTier,
          conversationId: focus.conversationId,
          turnId: focus.turnId,
          now: 1_752_800_000_000,
        }),
      )
      return executeEffect({ envelope, input: opts.input, execute: opts.execute, verify: opts.verify, db: effectDb })
    },
  }
}

let effectDb: FakeEffectDb
beforeEach(() => {
  effectDb = new FakeEffectDb()
})

describe('personal adapter: full plan → guard → effect → verify → resume', () => {
  it('create_reminder executes exactly once with verified proof; resume replays', async () => {
    const store = makeMemoryPersonalStore()
    const adapter = makePersonalRecordsAdapter(store)
    const ctx = makeWriteContext(effectDb, { conversationId: 'conv-os', turnId: 'turn-p1' })

    const first = await adapter.write('create_reminder', { text: 'ওষুধ খেতে হবে', at: '2026-07-18T21:00:00+06:00' }, ctx)
    expect(first.ok).toBe(true)
    expect(first.state).toBe('succeeded')
    expect(first.proof).toMatchObject({ kind: 'record_reread' })

    // RESUME: the identical call replays the stored outcome — no second reminder.
    const second = await adapter.write('create_reminder', { text: 'ওষুধ খেতে হবে', at: '2026-07-18T21:00:00+06:00' }, ctx)
    expect(second.ok).toBe(true)
    expect(second.replayed).toBe(true)
    expect((await store.listReminders()).filter((r) => !r.cancelled)).toHaveLength(1)

    expect(await verifyLedgerCompleteness(first.runId, effectDb)).toEqual([])
  })

  it('undo op (cancel_reminder) is itself a verified effect', async () => {
    const store = makeMemoryPersonalStore()
    const adapter = makePersonalRecordsAdapter(store)
    const ctx = makeWriteContext(effectDb, { conversationId: 'conv-os', turnId: 'turn-p2' })
    const created = await adapter.write('create_reminder', { text: 'x', at: '2026-07-19T09:00:00+06:00' }, ctx)
    const id = (created.result as { id?: string } | undefined)?.id ?? ''
    const cancelled = await adapter.write('cancel_reminder', { id }, makeWriteContext(effectDb, { conversationId: 'conv-os', turnId: 'turn-p3' }))
    expect(cancelled.ok).toBe(true)
    expect((await store.listReminders())[0]?.cancelled).toBe(true)
  })
})

describe('business adapter: full flow + drafts stay private', () => {
  it('add_order_note executes exactly once with record proof; remove undoes it', async () => {
    const store = makeMemoryOrdersStore()
    const adapter = makeErpOrdersAdapter(store)
    const ctx = makeWriteContext(effectDb, { conversationId: 'conv-os', turnId: 'turn-b1' })

    const added = await adapter.write('add_order_note', { orderId: 'o1', note: 'কাস্টমার কালকে ফোন করবে' }, ctx)
    expect(added.ok).toBe(true)
    expect(added.proof).toMatchObject({ kind: 'record_reread' })
    const noteId = (added.result as { noteId?: string } | undefined)?.noteId ?? ''

    const again = await adapter.write('add_order_note', { orderId: 'o1', note: 'কাস্টমার কালকে ফোন করবে' }, ctx)
    expect(again.replayed).toBe(true)

    const removed = await adapter.write('remove_order_note', { noteId }, makeWriteContext(effectDb, { conversationId: 'conv-os', turnId: 'turn-b2' }))
    expect(removed.ok).toBe(true)
  })

  it('customer updates can only be DRAFTED here — no send op exists on the adapter', async () => {
    const adapter = makeErpOrdersAdapter()
    const caps = adapter.capabilities()
    expect(caps.some((c) => /send|publish|post/.test(c.op))).toBe(false)
    const draft = await adapter.stage('draft_customer_update', { orderId: 'o1' })
    expect(draft.ok).toBe(true)
    expect((draft.draft as { note?: string }).note).toContain('পাঠানো হয়নি')
  })
})

describe('cross-service focus + scope isolation', () => {
  it('one focus (conversation/turn) binds effects across BOTH adapters in one task', async () => {
    const personal = makePersonalRecordsAdapter(makeMemoryPersonalStore())
    const business = makeErpOrdersAdapter(makeMemoryOrdersStore())
    const focus = { conversationId: 'conv-cross', turnId: 'turn-cross' }

    const note = await business.write('add_order_note', { orderId: 'o2', note: 'ফলো-আপ দরকার' }, makeWriteContext(effectDb, focus))
    const reminder = await personal.write('create_reminder', { text: 'অর্ডার o2 ফলো-আপ', at: '2026-07-18T11:00:00+06:00' }, makeWriteContext(effectDb, focus))
    expect(note.ok && reminder.ok).toBe(true)

    // Both effects carry the SAME focus binding in their durable runs.
    for (const run of effectDb.runs) {
      expect(run.conversationId).toBe('conv-cross')
      expect(run.turnId).toBe('turn-cross')
    }
    // And distinct idempotency identities — no accidental cross-service merge.
    expect(new Set(effectDb.runs.map((r) => r.idempotencyKey)).size).toBe(effectDb.runs.length)
  })

  it('adapters cannot reach ops outside their own scope surface', async () => {
    const personal = makePersonalRecordsAdapter()
    const business = makeErpOrdersAdapter()
    // Personal adapter knows nothing of order ops and vice versa.
    expect((await personal.read('order_summary', {})).ok).toBe(false)
    expect((await business.read('list_bills', {})).ok).toBe(false)
    // Scope labels are hard-typed on the adapter.
    expect(personal.scope).toBe('personal')
    expect(business.scope).toBe('business')
  })
})
