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

  // Phase 44 exit gate: autonomous content belongs to an approved strategy.
  // No approved growth brief (and enforcement on) → the slot politely skips
  // instead of generating strategy-less volume. kv growth.brief.enforce=false
  // is the owner's escape hatch (same switch the planner honors).
  try {
    const { data: enforceRow } = await supabase
      .from('agent_kv_settings')
      .select('value')
      .eq('key', 'growth.brief.enforce')
      .maybeSingle()
    const enforce = (enforceRow?.value ?? 'true').trim().toLowerCase() !== 'false'
    if (enforce) {
      const { data: brief } = await supabase
        .from('agent_growth_briefs')
        .select('id')
        .eq('businessId', 'ALMA_LIFESTYLE')
        .eq('status', 'approved')
        .limit(1)
        .maybeSingle()
      if (!brief) {
        const detail = `approved growth brief নেই — content slot বন্ধ (${timeLabel})`
        await markSlotRun(supabase, slot, 'skipped', detail)
        return { dutyStatus: 'skipped', dutyDetail: detail }
      }
    }
  } catch (briefErr) {
    // Brief check must never take the whole content engine down.
    console.warn(`[content-engine] brief gate check failed open: ${briefErr.message}`)
  }

  let res
  try {
    res = await fetch(`${getAppUrl()}/api/assistant/internal/content-engine-run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getInternalToken()}`,
      },
      body: JSON.stringify({ slot }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (fetchErr) {
    const detail = `fetch failed: ${fetchErr.message}`
    console.error(`[content-engine] slot ${slot} ${detail}`)
    await markSlotRun(supabase, slot, 'failed', detail)
    return { dutyStatus: 'failed', dutyDetail: detail }
  }

  let data = {}
  try {
    data = await res.json()
  } catch {
    data = { error: `HTTP ${res.status} (non-JSON body)` }
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
