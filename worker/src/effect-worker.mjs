/**
 * Phase 53 — VPS effect-outbox dispatcher + reconciler tick.
 *
 * Sweeps the transactional outbox (agent_effect_outbox) the Vercel side
 * commits atomically with each action run, and drives dispatch with leases,
 * deterministic backoff, and dead-lettering. Also nudges stale runs
 * (executing/verifying beyond the stale window, unknown_effect) toward the
 * app-side reconciler.
 *
 * Column names are Prisma @map snake_case (agent_action_runs / agent_effect_*).
 * The whole module is dependency-injected (supabase-like client + dispatch fn)
 * so node --test can drive it with fakes — see __tests__/effect-worker.test.mjs.
 *
 * Gated by AGENT_EFFECT_ENGINE=true (index.mjs); OFF by default per the
 * roadmap's readiness doctrine.
 */

/** Deterministic exponential backoff — mirror of src/agent/lib/effects/outbox.ts. */
export function computeBackoffMs(attempt) {
  const base = 15_000
  const capped = Math.min(attempt, 10)
  return Math.min(5 * 60_000, base * 2 ** Math.max(0, capped - 1))
}

/** @returns {boolean} lease is free or expired at `nowIso` */
export function isLeaseFree(row, nowIso) {
  return !row.lease_until || row.lease_until <= nowIso
}

/** States a dispatcher may act on. Anything else is app-side/reconciler work. */
export const DISPATCHABLE_STATES = new Set(['claimed', 'failed_retryable'])

/** Terminal states — the outbox row is stale garbage and should be removed. */
export const TERMINAL_STATES = new Set(['succeeded', 'denied', 'expired', 'failed_final', 'compensated'])

/**
 * Lease due outbox rows (compare-and-swap on lease_until so duplicate workers
 * cannot hold the same row).
 *
 * @param {object} sb supabase-like client
 * @param {{ owner: string, limit?: number, leaseMs?: number, now?: Date }} opts
 */
export async function leaseDueOutboxRows(sb, opts) {
  const now = opts.now ?? new Date()
  const nowIso = now.toISOString()
  const leaseUntil = new Date(now.getTime() + (opts.leaseMs ?? 60_000)).toISOString()

  const { data: due, error } = await sb
    .from('agent_effect_outbox')
    .select('*')
    .lte('due_at', nowIso)
    .order('due_at', { ascending: true })
    .limit(opts.limit ?? 10)
  if (error) throw new Error(`outbox select failed: ${error.message}`)

  const leased = []
  for (const row of due ?? []) {
    if (!isLeaseFree(row, nowIso)) continue
    let claim = sb
      .from('agent_effect_outbox')
      .update({ lease_until: leaseUntil, lease_owner: opts.owner, attempts: row.attempts + 1 })
      .eq('id', row.id)
    claim = row.lease_until === null ? claim.is('lease_until', null) : claim.eq('lease_until', row.lease_until)
    const { data: updated, error: claimErr } = await claim.select()
    if (claimErr) continue
    if ((updated ?? []).length === 1) {
      leased.push({ ...row, lease_until: leaseUntil, lease_owner: opts.owner, attempts: row.attempts + 1 })
    }
  }
  return leased
}

/** Append one ledger row (next seq) — failure throws so callers abort loudly. */
export async function appendLedgerRow(sb, runId, kind, payload, fromState, toState) {
  const { data: last, error: seqErr } = await sb
    .from('agent_effect_ledger')
    .select('seq')
    .eq('run_id', runId)
    .order('seq', { ascending: false })
    .limit(1)
  if (seqErr) throw new Error(`ledger seq read failed: ${seqErr.message}`)
  const seq = ((last ?? [])[0]?.seq ?? 0) + 1
  const { error } = await sb.from('agent_effect_ledger').insert({
    id: globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${runId}-${seq}`,
    run_id: runId,
    seq,
    kind,
    from_state: fromState ?? null,
    to_state: toState ?? null,
    payload: payload ?? null,
  })
  if (error) throw new Error(`ledger insert failed: ${error.message}`)
}

/**
 * One dispatcher tick:
 *   lease due rows → look up their runs →
 *     terminal run          → drop the outbox row
 *     dispatchable run      → dispatch(run); success removes the row,
 *                             failure reschedules with backoff or dead-letters
 *     anything else         → release for the reconciler (backoff, no dead-letter)
 *
 * @param {object} deps { sb, dispatch(run) => Promise<{ok:boolean,error?:string}>, owner?, now? }
 */
export async function runEffectOutboxTick(deps) {
  const { sb, dispatch } = deps
  const owner = deps.owner ?? 'effect-worker'
  const now = deps.now ?? new Date()
  const summary = { leased: 0, dispatched: 0, rescheduled: 0, deadLettered: 0, dropped: 0, skipped: 0 }

  const leased = await leaseDueOutboxRows(sb, { owner, now })
  summary.leased = leased.length

  for (const row of leased) {
    const { data: runRows, error } = await sb.from('agent_action_runs').select('*').eq('id', row.run_id).limit(1)
    if (error || !(runRows ?? [])[0]) {
      await sb.from('agent_effect_outbox').delete().eq('id', row.id)
      summary.dropped += 1
      continue
    }
    const run = runRows[0]

    if (TERMINAL_STATES.has(run.state)) {
      await sb.from('agent_effect_outbox').delete().eq('id', row.id)
      summary.dropped += 1
      continue
    }

    if (!DISPATCHABLE_STATES.has(run.state)) {
      // executing/verifying/unknown_effect belong to the reconciler — release.
      await sb
        .from('agent_effect_outbox')
        .update({ lease_until: null, lease_owner: null, due_at: new Date(now.getTime() + computeBackoffMs(row.attempts)).toISOString() })
        .eq('id', row.id)
      summary.skipped += 1
      continue
    }

    let result
    try {
      result = await dispatch(run)
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }

    if (result.ok) {
      await sb.from('agent_effect_outbox').delete().eq('id', row.id)
      summary.dispatched += 1
      continue
    }

    if (row.attempts >= row.max_attempts) {
      // Dead-letter: failed_final + ledger row, never a silent drop.
      await appendLedgerRow(sb, run.id, 'transition', { deadLetter: true, attempts: row.attempts, error: String(result.error ?? 'dispatch failed').slice(0, 500) }, run.state, 'failed_final')
      await sb
        .from('agent_action_runs')
        .update({ state: 'failed_final', state_version: run.state_version + 1, error: `outbox dead-letter: ${String(result.error ?? '').slice(0, 300)}` })
        .eq('id', run.id)
        .eq('state', run.state)
      await sb.from('agent_effect_outbox').delete().eq('id', row.id)
      summary.deadLettered += 1
      continue
    }

    await sb
      .from('agent_effect_outbox')
      .update({ lease_until: null, lease_owner: null, due_at: new Date(now.getTime() + computeBackoffMs(row.attempts)).toISOString() })
      .eq('id', row.id)
    summary.rescheduled += 1
  }

  return summary
}

/**
 * Start the polling loop (index.mjs). Returns the interval handle.
 * @param {object} deps { sb, dispatch, intervalMs?, log? }
 */
export function startEffectWorkerLoop(deps) {
  const intervalMs = deps.intervalMs ?? 15_000
  const log = deps.log ?? ((...a) => console.log('[effect-worker]', ...a))
  let running = false
  const handle = setInterval(async () => {
    if (running) return // no overlapping ticks
    running = true
    try {
      const summary = await runEffectOutboxTick(deps)
      if (summary.leased > 0) log('tick', JSON.stringify(summary))
    } catch (err) {
      log('tick failed:', err instanceof Error ? err.message : err)
    } finally {
      running = false
    }
  }, intervalMs)
  handle.unref?.()
  return handle
}
