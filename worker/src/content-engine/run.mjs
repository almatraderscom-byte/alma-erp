/**
 * Autonomous content engine slot runner (Phase 3).
 * Preparation only — pipeline stops at Gate 1; owner must approve twice to publish.
 */
import { getAppUrl, getInternalToken } from '../env.mjs'
import { isWithinOfficeHours } from '../staff/office-hours.mjs'

const SLOT_TIMES = {
  1: '10:00',
  2: '15:00',
  3: '19:00',
}

function dhakaToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

function slotIdempotencyKey(slot) {
  return `content_engine_slot_${slot}_${dhakaToday()}`
}

async function markSlotRun(supabase, slot, status, detail) {
  await supabase.from('agent_kv_settings').upsert({
    key: slotIdempotencyKey(slot),
    value: JSON.stringify({ status, detail, at: new Date().toISOString() }),
    updated_at: new Date().toISOString(),
  })
}

async function slotAlreadyRan(supabase, slot) {
  const { data } = await supabase
    .from('agent_kv_settings')
    .select('value')
    .eq('key', slotIdempotencyKey(slot))
    .maybeSingle()
  if (!data?.value) return false
  try {
    const parsed = JSON.parse(data.value)
    return parsed.status === 'done' || parsed.status === 'skipped'
  } catch {
    return data.value === 'done' || data.value === 'skipped'
  }
}

/**
 * @param {{ supabase: import('@supabase/supabase-js').SupabaseClient, slot: number }} args
 */
export async function runContentEngineSlot({ supabase, slot }) {
  const timeLabel = SLOT_TIMES[slot] ?? `slot-${slot}`

  if (!isWithinOfficeHours('ALMA_LIFESTYLE')) {
    const detail = `office hours বাইরে (${timeLabel} Dhaka)`
    await markSlotRun(supabase, slot, 'skipped', detail)
    return { dutyStatus: 'skipped', dutyDetail: detail }
  }

  if (await slotAlreadyRan(supabase, slot)) {
    return { dutyStatus: 'skipped', dutyDetail: `ইতিমধ্যে চালানো হয়েছে (${timeLabel})` }
  }

  const res = await fetch(`${getAppUrl()}/api/assistant/internal/content-engine-run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getInternalToken()}`,
    },
    body: JSON.stringify({ slot }),
  })

  let data = {}
  try {
    data = await res.json()
  } catch {
    data = { error: `HTTP ${res.status}` }
  }

  if (!res.ok) {
    const detail = data.error ?? `API ${res.status}`
    await markSlotRun(supabase, slot, 'failed', detail)
    return { dutyStatus: 'failed', dutyDetail: detail }
  }

  if (data.skipped) {
    const detail = `${data.reason ?? 'skipped'} (${timeLabel})`
    await markSlotRun(supabase, slot, 'skipped', detail)
    return { dutyStatus: 'skipped', dutyDetail: detail }
  }

  const detail = `${data.productCode} → Gate 1 | ${data.theme ?? ''} (${timeLabel})`
  await markSlotRun(supabase, slot, 'done', detail)
  return { dutyStatus: 'done', dutyDetail: detail }
}
