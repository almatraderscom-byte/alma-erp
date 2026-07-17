/**
 * Phase 53 — the APPEND-ONLY effect ledger.
 *
 * Every state transition, provider receipt, postcondition proof, and
 * compensation record for an action run lands here as an immutable row with a
 * per-run gapless sequence. There is deliberately NO update or delete API in
 * this module — the ledger is evidence, not state.
 *
 * CONTRACT: appendLedger runs INSIDE the same transaction as the state change
 * it records. If the ledger insert fails, the transaction aborts and the write
 * never happens — "logging failure blocks the effect" (constitution rule 8 /
 * roadmap Phase 53 requirement). The old 100-entry KV ring in
 * autonomy-ledger.ts remains only as a derived recent-view cache.
 *
 * All DB access goes through the structural EffectDb interface so the engine
 * is testable with an in-memory fake (no prisma mocking).
 */
import { prisma } from '@/lib/prisma'

// ── Structural DB interface (subset of PrismaClient the engine uses) ─────────

export interface ActionRunRow {
  id: string
  idempotencyKey: string
  effectHash: string
  tool: string
  surface: string
  actor: string
  instructionOrigin: string
  conversationId: string | null
  turnId: string | null
  businessId: string | null
  riskTier: string
  policyVersion: string
  approvalRef: string | null
  state: string
  stateVersion: number
  attempts: number
  input: unknown
  destination: string | null
  providerRef: string | null
  proof: unknown
  result: unknown
  costUsd: number | null
  moneyTaka: number | null
  error: string | null
  compensationOfId: string | null
  createdAt: Date
  updatedAt: Date
}

export interface LedgerRow {
  id: string
  runId: string
  seq: number
  kind: string
  fromState: string | null
  toState: string | null
  payload: unknown
  at: Date
}

export interface OutboxRow {
  id: string
  runId: string
  dueAt: Date
  leaseUntil: Date | null
  leaseOwner: string | null
  attempts: number
  maxAttempts: number
  createdAt: Date
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface EffectDb {
  agentActionRun: {
    create(args: { data: any }): Promise<ActionRunRow>
    findUnique(args: { where: any }): Promise<ActionRunRow | null>
    findMany(args?: any): Promise<ActionRunRow[]>
    update(args: { where: any; data: any }): Promise<ActionRunRow>
    updateMany(args: { where: any; data: any }): Promise<{ count: number }>
  }
  agentEffectLedger: {
    create(args: { data: any }): Promise<LedgerRow>
    findMany(args?: any): Promise<LedgerRow[]>
  }
  agentEffectOutbox: {
    create(args: { data: any }): Promise<OutboxRow>
    findMany(args?: any): Promise<OutboxRow[]>
    update(args: { where: any; data: any }): Promise<OutboxRow>
    updateMany(args: { where: any; data: any }): Promise<{ count: number }>
    deleteMany(args: { where: any }): Promise<{ count: number }>
  }
  $transaction<T>(fn: (tx: EffectDb) => Promise<T>): Promise<T>
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** The production client, typed structurally. */
export function defaultEffectDb(): EffectDb {
  return prisma as unknown as EffectDb
}

export type LedgerKind = 'transition' | 'receipt' | 'evidence' | 'proof' | 'compensation' | 'note'

/**
 * Append one immutable ledger row INSIDE the caller's transaction.
 * Throws on failure — the caller's transaction (and therefore the state
 * change/effect) must abort with it.
 */
export async function appendLedger(
  tx: EffectDb,
  runId: string,
  kind: LedgerKind,
  opts: { fromState?: string; toState?: string; payload?: unknown } = {},
): Promise<LedgerRow> {
  const last = await tx.agentEffectLedger.findMany({
    where: { runId },
    orderBy: { seq: 'desc' },
    take: 1,
  })
  const seq = (last[0]?.seq ?? 0) + 1
  return tx.agentEffectLedger.create({
    data: {
      runId,
      seq,
      kind,
      fromState: opts.fromState ?? null,
      toState: opts.toState ?? null,
      payload: opts.payload ?? null,
    },
  })
}

/** Full evidence chain for one run, in order. Read-only. */
export async function getLedgerChain(runId: string, db: EffectDb = defaultEffectDb()): Promise<LedgerRow[]> {
  return db.agentEffectLedger.findMany({ where: { runId }, orderBy: { seq: 'asc' } })
}

/**
 * Ledger completeness check (Phase 53 exit gate): a run's chain must contain a
 * transition row for every state it passed through and — for succeeded runs —
 * a proof row. Returns human-readable problems ([] = complete).
 */
export async function verifyLedgerCompleteness(runId: string, db: EffectDb = defaultEffectDb()): Promise<string[]> {
  const problems: string[] = []
  const run = await db.agentActionRun.findUnique({ where: { id: runId } })
  if (!run) return [`run ${runId} not found`]
  const chain = await getLedgerChain(runId, db)
  if (chain.length === 0) return [`run ${runId} has an empty ledger`]

  for (let i = 0; i < chain.length; i += 1) {
    if (chain[i].seq !== i + 1) {
      problems.push(`run ${runId}: ledger sequence gap at position ${i} (seq ${chain[i].seq})`)
      break
    }
  }

  const transitions = chain.filter((r) => r.kind === 'transition')
  const lastTransition = transitions[transitions.length - 1]
  if (!lastTransition || lastTransition.toState !== run.state) {
    problems.push(`run ${runId}: final state ${run.state} has no matching transition row`)
  }
  if (run.state === 'succeeded' && !chain.some((r) => r.kind === 'proof')) {
    problems.push(`run ${runId}: succeeded without a proof row`)
  }
  return problems
}
