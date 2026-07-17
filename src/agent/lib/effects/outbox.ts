/**
 * Phase 53 — transactional outbox for effect dispatch.
 *
 * When an effect must be dispatched asynchronously (VPS worker, deferred
 * send), the intent is committed ATOMICALLY with the action run: run row +
 * ledger chain + outbox row in one transaction. The dispatcher (worker or
 * cron) then leases due rows and drives executeEffect — a crash between
 * commit and dispatch loses nothing, and double-dispatch collapses onto the
 * run's idempotency key.
 */
import { appendLedger, defaultEffectDb, type EffectDb, type OutboxRow } from './effect-ledger'

/** Deterministic exponential backoff (no jitter — replay-safe): 15s, 30s, 60s… capped at 5 min. */
export function computeBackoffMs(attempt: number): number {
  const base = 15_000
  const capped = Math.min(attempt, 10)
  return Math.min(5 * 60_000, base * 2 ** Math.max(0, capped - 1))
}

/** Enqueue dispatch for a run INSIDE the caller's transaction. */
export async function enqueueEffectDispatch(
  tx: EffectDb,
  runId: string,
  opts: { dueAt?: Date; maxAttempts?: number } = {},
): Promise<OutboxRow> {
  const row = await tx.agentEffectOutbox.create({
    data: {
      runId,
      dueAt: opts.dueAt ?? new Date(),
      maxAttempts: opts.maxAttempts ?? 5,
    },
  })
  await appendLedger(tx, runId, 'note', { payload: { outbox: 'enqueued', dueAt: (opts.dueAt ?? new Date()).toISOString() } })
  return row
}

export interface LeaseResult {
  leased: OutboxRow[]
}

/**
 * Lease due outbox rows for one dispatcher. Compare-and-swap per row: a row is
 * leased only when unleased or its lease expired, so duplicate workers cannot
 * hold the same row.
 */
export async function leaseDueOutbox(
  db: EffectDb,
  opts: { owner: string; limit?: number; leaseMs?: number; now?: Date },
): Promise<LeaseResult> {
  const now = opts.now ?? new Date()
  const leaseUntil = new Date(now.getTime() + (opts.leaseMs ?? 60_000))
  const due = await db.agentEffectOutbox.findMany({
    where: { dueAt: { lte: now } },
    orderBy: { dueAt: 'asc' },
    take: opts.limit ?? 10,
  })
  const leased: OutboxRow[] = []
  for (const row of due) {
    if (row.leaseUntil && row.leaseUntil > now) continue
    const claimed = await db.agentEffectOutbox.updateMany({
      where: { id: row.id, leaseUntil: row.leaseUntil },
      data: { leaseUntil, leaseOwner: opts.owner, attempts: row.attempts + 1 },
    })
    if (claimed.count === 1) leased.push({ ...row, leaseUntil, leaseOwner: opts.owner, attempts: row.attempts + 1 })
  }
  return { leased }
}

/** Dispatch completed — remove the outbox row (the run holds the outcome). */
export async function completeOutboxItem(db: EffectDb, id: string): Promise<void> {
  await db.agentEffectOutbox.deleteMany({ where: { id } })
}

export interface FailOutboxResult {
  deadLettered: boolean
  nextDueAt?: Date
}

/**
 * Dispatch failed. Reschedule with deterministic backoff, or dead-letter after
 * maxAttempts: the run is marked failed_final WITH a ledger row and the outbox
 * row removed — silent drop is not an option.
 */
export async function failOutboxItem(
  db: EffectDb,
  row: OutboxRow,
  opts: { error: string; now?: Date },
): Promise<FailOutboxResult> {
  const now = opts.now ?? new Date()
  if (row.attempts >= row.maxAttempts) {
    await db.$transaction(async (tx) => {
      const run = await tx.agentActionRun.findUnique({ where: { id: row.runId } })
      if (run && !['succeeded', 'failed_final', 'denied', 'expired', 'compensated'].includes(run.state)) {
        await tx.agentActionRun.updateMany({
          where: { id: run.id, state: run.state },
          data: { state: 'failed_final', stateVersion: run.stateVersion + 1, error: `outbox dead-letter: ${opts.error}` },
        })
        await appendLedger(tx, run.id, 'transition', {
          fromState: run.state,
          toState: 'failed_final',
          payload: { deadLetter: true, attempts: row.attempts, error: opts.error.slice(0, 500) },
        })
      }
      await tx.agentEffectOutbox.deleteMany({ where: { id: row.id } })
    })
    return { deadLettered: true }
  }
  const nextDueAt = new Date(now.getTime() + computeBackoffMs(row.attempts))
  await db.agentEffectOutbox.update({
    where: { id: row.id },
    data: { dueAt: nextDueAt, leaseUntil: null, leaseOwner: null },
  })
  return { deadLettered: false, nextDueAt }
}

/** Rows visible to dashboards: due, leased, and overdue counts. */
export async function outboxHealth(db: EffectDb = defaultEffectDb(), now: Date = new Date()): Promise<{ due: number; leased: number }> {
  const rows = await db.agentEffectOutbox.findMany({ where: {} })
  let due = 0
  let leased = 0
  for (const r of rows) {
    if (r.leaseUntil && r.leaseUntil > now) leased += 1
    else if (r.dueAt <= now) due += 1
  }
  return { due, leased }
}
