/**
 * Phase 58 — VPS autonomy reconciler.
 *
 * The continuous safety sweep behind the SLO gates:
 *   • stale `executing` effects (worker died mid-dispatch) → unknown_effect
 *     with a ledger row — never blind-retried
 *   • long-stuck unknown_effect runs → owner notification (once per run)
 *   • expired outbox leases → released so a healthy dispatcher can resume
 *   • returns a summary the SLO panel/chaos suite can assert on
 *
 * Injectable supabase-like client + notify fn → node --test drives it with
 * fakes (see __tests__/autonomy-chaos.test.mjs).
 */

export const STALE_EXECUTING_MS = 10 * 60_000
export const UNKNOWN_ALERT_AFTER_MS = 60 * 60_000

async function appendLedgerRow(sb, runId, kind, payload, fromState, toState) {
  const { data: last, error: seqErr } = await sb
    .from('agent_effect_ledger')
    .select('seq')
    .eq('run_id', runId)
    .order('seq', { ascending: false })
    .limit(1)
  if (seqErr) throw new Error(`ledger seq read failed: ${seqErr.message}`)
  const seq = ((last ?? [])[0]?.seq ?? 0) + 1
  const { error } = await sb.from('agent_effect_ledger').insert({
    id: globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${runId}-l${seq}`,
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
 * One reconciler tick.
 * @param {{ sb: object, notify?: (msg: string) => Promise<void>, now?: Date }} deps
 */
export async function runAutonomyReconcilerTick(deps) {
  const { sb } = deps
  const now = deps.now ?? new Date()
  const notify = deps.notify ?? (async () => {})
  const summary = { staleExecutingMarked: 0, unknownAlerts: 0, leasesReleased: 0, errors: [] }

  // 1. Stale executing → unknown_effect (crash marker), CAS on state.
  try {
    const staleBefore = new Date(now.getTime() - STALE_EXECUTING_MS).toISOString()
    const { data: stale, error } = await sb
      .from('agent_action_runs')
      .select('*')
      .eq('state', 'executing')
      .lte('updated_at', staleBefore)
      .limit(25)
    if (error) throw new Error(error.message)
    for (const run of stale ?? []) {
      const { data: updated } = await sb
        .from('agent_action_runs')
        .update({ state: 'unknown_effect', state_version: run.state_version + 1, error: 'stale executing — worker died mid-dispatch' })
        .eq('id', run.id)
        .eq('state', 'executing')
        .select()
      if ((updated ?? []).length === 1) {
        await appendLedgerRow(sb, run.id, 'transition', { reconciler: 'stale_executing' }, 'executing', 'unknown_effect')
        summary.staleExecutingMarked += 1
      }
    }
  } catch (err) {
    summary.errors.push(`stale sweep: ${err?.message ?? err}`)
  }

  // 2. Long-stuck unknown_effect → owner alert once (flag via ledger note).
  try {
    const alertBefore = new Date(now.getTime() - UNKNOWN_ALERT_AFTER_MS).toISOString()
    const { data: unknowns, error } = await sb
      .from('agent_action_runs')
      .select('*')
      .eq('state', 'unknown_effect')
      .lte('updated_at', alertBefore)
      .limit(10)
    if (error) throw new Error(error.message)
    for (const run of unknowns ?? []) {
      const { data: notes } = await sb
        .from('agent_effect_ledger')
        .select('*')
        .eq('run_id', run.id)
        .eq('kind', 'note')
        .limit(50)
      const alreadyAlerted = (notes ?? []).some((n) => n.payload && n.payload.ownerAlerted)
      if (alreadyAlerted) continue
      await notify(
        `Boss, একটা কাজের ফলাফল অনিশ্চিত হয়ে আটকে আছে (${run.tool}) — provider-এ আসলেই হয়েছে কিনা যাচাই দরকার। রেফারেন্স: ${run.id}`,
      )
      await appendLedgerRow(sb, run.id, 'note', { ownerAlerted: true, at: now.toISOString() })
      summary.unknownAlerts += 1
    }
  } catch (err) {
    summary.errors.push(`unknown sweep: ${err?.message ?? err}`)
  }

  // 3. Expired outbox leases → release (dispatcher may have died holding them).
  try {
    const nowIso = now.toISOString()
    const { data: rows, error } = await sb.from('agent_effect_outbox').select('*').lte('lease_until', nowIso).limit(50)
    if (error) throw new Error(error.message)
    for (const row of rows ?? []) {
      if (!row.lease_until) continue
      const { data: updated } = await sb
        .from('agent_effect_outbox')
        .update({ lease_until: null, lease_owner: null })
        .eq('id', row.id)
        .eq('lease_until', row.lease_until)
        .select()
      if ((updated ?? []).length === 1) summary.leasesReleased += 1
    }
  } catch (err) {
    summary.errors.push(`lease sweep: ${err?.message ?? err}`)
  }

  return summary
}

/**
 * Start the loop (wired from index.mjs behind AGENT_EFFECT_ENGINE).
 * @param {{ sb: object, notify?: Function, intervalMs?: number, log?: Function }} deps
 */
export function startAutonomyReconcilerLoop(deps) {
  const intervalMs = deps.intervalMs ?? 5 * 60_000
  const log = deps.log ?? ((...a) => console.log('[autonomy-reconciler]', ...a))
  let running = false
  const handle = setInterval(async () => {
    if (running) return
    running = true
    try {
      const summary = await runAutonomyReconcilerTick(deps)
      if (summary.staleExecutingMarked || summary.unknownAlerts || summary.leasesReleased || summary.errors.length) {
        log('tick', JSON.stringify(summary))
      }
    } catch (err) {
      log('tick failed:', err?.message ?? err)
    } finally {
      running = false
    }
  }, intervalMs)
  handle.unref?.()
  return handle
}
