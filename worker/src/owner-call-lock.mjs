/**
 * Hard owner call lock — worker mirror of src/lib/owner-call-lock.ts.
 * Blocks Twilio outbound + salah retries while owner delay lock is active.
 */
import { createClient } from '@supabase/supabase-js'

export const OWNER_CALL_LOCK_KEY = 'owner_call_lock_until'

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  )
}

function parseIsoDate(value) {
  if (!value) return null
  const d = new Date(value)
  return Number.isFinite(d.getTime()) ? d : null
}

export async function getOwnerCallLockUntil() {
  const { data } = await getSupabase()
    .from('agent_kv_settings')
    .select('value')
    .eq('key', OWNER_CALL_LOCK_KEY)
    .maybeSingle()
  return parseIsoDate(data?.value)
}

export async function getActiveSalahDelayUntil(now = new Date()) {
  const { data } = await getSupabase()
    .from('salah_overrides')
    .select('delay_until')
    .gt('delay_until', now.toISOString())
    .order('delay_until', { ascending: false })
    .limit(1)

  return parseIsoDate(data?.[0]?.delay_until)
}

export async function isOwnerCallLocked(now = new Date()) {
  const kv = await getOwnerCallLockUntil()
  if (kv && now < kv) return { locked: true, until: kv, source: 'kv' }

  const salahDelay = await getActiveSalahDelayUntil(now)
  if (salahDelay && now < salahDelay) {
    return { locked: true, until: salahDelay, source: 'salah_override' }
  }

  return { locked: false }
}

export async function setOwnerCallLockUntil(until, { extend = true } = {}) {
  if (!until || !Number.isFinite(until.getTime())) return

  let effective = until
  if (extend) {
    const existing = await getOwnerCallLockUntil()
    if (existing && existing > effective) effective = existing
  }

  await getSupabase().from('agent_kv_settings').upsert({
    key: OWNER_CALL_LOCK_KEY,
    value: effective.toISOString(),
    updated_at: new Date().toISOString(),
  })
}
