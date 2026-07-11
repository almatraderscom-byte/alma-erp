/**
 * Worker mirror of src/lib/salah/snooze-state.ts — SAME agent_kv_settings keys.
 * The scheduler + snooze-followup job read/write these to:
 *   - show only the ১৫ min button once ৩০ has been used (snooze30_used),
 *   - drive the post-snooze reminder→call loop (followup: JSON {remindAt, callAt}),
 *   - send the "15 min before jamat" heads-up exactly once (pre15).
 *
 * The critical write (call-lock + override + followup-arm) happens on the WEB via
 * /api/assistant/internal/salah-snooze. The worker advances the followup state
 * (reminder-sent, callAt bumps) and clears it on confirm/window-end.
 */

export function snooze30UsedKey(ymd, waqt) {
  return `salah_snooze30_used:${ymd}:${waqt}`
}
export function followupKeyPrefix(ymd) {
  return `salah_followup:${ymd}:`
}
export function followupKey(ymd, waqt) {
  return `salah_followup:${ymd}:${waqt}`
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

/** All waqts that currently have an armed post-snooze follow-up for `ymd`. */
export async function listFollowupWaqts(supabase, ymd) {
  const { data } = await supabase
    .from('agent_kv_settings')
    .select('key')
    .like('key', `${followupKeyPrefix(ymd)}%`)
  return (data ?? [])
    .map((r) => r.key.slice(followupKeyPrefix(ymd).length))
    .filter(Boolean)
}

/** Is a post-snooze follow-up armed for this waqt right now? (main ladder defers to it) */
export async function hasFollowup(supabase, ymd, waqt) {
  return (await getKv(supabase, followupKey(ymd, waqt))) != null
}

/** Follow-up state {remindAt, callAt} (ISO|null each), or null if none armed. */
export async function getFollowupState(supabase, ymd, waqt) {
  const raw = await getKv(supabase, followupKey(ymd, waqt))
  if (!raw) return null
  try {
    const o = JSON.parse(raw)
    return { remindAt: o.remindAt ?? null, callAt: o.callAt ?? null }
  } catch {
    return null
  }
}

export async function setFollowupState(supabase, ymd, waqt, state) {
  await setKv(supabase, followupKey(ymd, waqt), JSON.stringify({
    remindAt: state.remindAt ?? null,
    callAt: state.callAt ?? null,
  }))
}

export async function clearFollowup(supabase, ymd, waqt) {
  await delKv(supabase, followupKey(ymd, waqt))
}

export async function isPre15Sent(supabase, ymd, waqt) {
  return (await getKv(supabase, pre15Key(ymd, waqt))) === '1'
}

export async function markPre15Sent(supabase, ymd, waqt) {
  await setKv(supabase, pre15Key(ymd, waqt), '1')
}
