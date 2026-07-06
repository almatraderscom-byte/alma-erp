/**
 * Worker mirror of src/lib/salah/snooze-state.ts — SAME agent_kv_settings keys.
 * The scheduler reads these markers (and writes the reminder-side ones) to:
 *   - show only the ১৫ min button once ৩০ has been used (snooze30_used),
 *   - send ONE reminder-with-buttons when a snooze lock expires (reremind),
 *   - send the "15 min before jamat" heads-up exactly once (pre15).
 *
 * The critical writes (call-lock, override, 30-used, reremind-set) happen on the
 * WEB via /api/assistant/internal/salah-snooze. The worker only writes the two
 * reminder-idempotency markers (pre15-set, reremind-clear) — a lost write there
 * only risks a duplicate Telegram reminder, never a slipped call.
 */

export function snooze30UsedKey(ymd, waqt) {
  return `salah_snooze30_used:${ymd}:${waqt}`
}
export function reremindKey(ymd, waqt) {
  return `salah_reremind:${ymd}:${waqt}`
}
export function pre15Key(ymd, waqt) {
  return `salah_pre15:${ymd}:${waqt}`
}

async function getKv(supabase, key) {
  const { data } = await supabase
    .from('agent_kv_settings')
    .select('value')
    .eq('key', key)
    .maybeSingle()
  return data?.value ?? null
}

async function setKv(supabase, key, value) {
  await supabase
    .from('agent_kv_settings')
    .upsert({ key, value, updated_at: new Date().toISOString() })
}

async function delKv(supabase, key) {
  await supabase.from('agent_kv_settings').delete().eq('key', key)
}

/** Has the one-time 30-min snooze been used for this waqt today? */
export async function is30SnoozeUsed(supabase, ymd, waqt) {
  return (await getKv(supabase, snooze30UsedKey(ymd, waqt))) === '1'
}

/** Returns the Date a re-reminder becomes due, or null if none is owed. */
export async function getReremindDue(supabase, ymd, waqt) {
  const raw = await getKv(supabase, reremindKey(ymd, waqt))
  if (!raw) return null
  const d = new Date(raw)
  return Number.isFinite(d.getTime()) ? d : null
}

export async function clearReremind(supabase, ymd, waqt) {
  await delKv(supabase, reremindKey(ymd, waqt))
}

export async function isPre15Sent(supabase, ymd, waqt) {
  return (await getKv(supabase, pre15Key(ymd, waqt))) === '1'
}

export async function markPre15Sent(supabase, ymd, waqt) {
  await setKv(supabase, pre15Key(ymd, waqt), '1')
}
