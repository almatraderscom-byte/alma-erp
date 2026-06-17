/**
 * Reliable agent_duty_log writes — production DB requires explicit UUID on INSERT.
 * Never swallow errors: callers must see failures in PM2 logs.
 */
import { randomUUID } from 'crypto'

/**
 * @param {object} row
 * @param {string} row.duty
 * @param {string} row.label
 * @param {string} row.dutyDate
 * @param {string} row.status
 * @param {string|null} [row.detail]
 * @param {string|null} [row.ranAt]
 */
export function buildDutyLogInsert(row) {
  const ranAt = row.ranAt ?? (row.status === 'pending' ? null : new Date().toISOString())
  return {
    id: randomUUID(),
    duty: row.duty,
    label: row.label,
    duty_date: row.dutyDate,
    status: row.status,
    detail: row.detail ?? null,
    ran_at: ranAt,
  }
}

/**
 * Upsert by (duty, duty_date) — update existing row or insert with fresh UUID.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
export async function upsertDutyLog(supabase, row) {
  const { data: existing, error: readErr } = await supabase
    .from('agent_duty_log')
    .select('id')
    .eq('duty', row.duty)
    .eq('duty_date', row.dutyDate)
    .maybeSingle()

  if (readErr) {
    throw new Error(`duty-log read: ${readErr.message}`)
  }

  const ranAt = row.ranAt ?? (row.status === 'pending' ? null : new Date().toISOString())
  const payload = {
    duty: row.duty,
    label: row.label,
    duty_date: row.dutyDate,
    status: row.status,
    detail: row.detail ?? null,
    ran_at: ranAt,
  }

  if (existing?.id) {
    const { error } = await supabase.from('agent_duty_log').update(payload).eq('id', existing.id)
    if (error) throw new Error(`duty-log update: ${error.message}`)
    return existing.id
  }

  const { error: insertErr } = await supabase
    .from('agent_duty_log')
    .insert(buildDutyLogInsert({ ...row, ranAt }))
  if (insertErr) {
    if (insertErr.code === '23505') {
      const { error: retryErr } = await supabase
        .from('agent_duty_log')
        .update(payload)
        .eq('duty', row.duty)
        .eq('duty_date', row.dutyDate)
      if (retryErr) throw new Error(`duty-log retry update: ${retryErr.message}`)
      return null
    }
    throw new Error(`duty-log insert: ${insertErr.message}`)
  }
  return null
}

/**
 * Idempotent pending seed — skips if row already exists.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
export async function insertPendingDutyLog(supabase, { duty, label, dutyDate }) {
  const { data: existing } = await supabase
    .from('agent_duty_log')
    .select('id')
    .eq('duty', duty)
    .eq('duty_date', dutyDate)
    .maybeSingle()
  if (existing) return

  const { error } = await supabase
    .from('agent_duty_log')
    .insert(buildDutyLogInsert({ duty, label, dutyDate, status: 'pending' }))
  if (error && error.code !== '23505') {
    throw new Error(`duty-log seed: ${error.message}`)
  }
}
