/**
 * Office off-day gate (Dhaka).
 *
 * The office is OFF on Fridays (weekly holiday) and on any date listed in
 * AgentSettings.holidays (the same list the owner edits from the agent app).
 * On an off-day the agent must NOT run staff-facing office jobs — no morning
 * dispatch, no presence/morale pings, no productivity/geo monitoring, etc.
 *
 * This is the SINGLE source of truth for "is the office closed today" on the
 * worker side. It is read-only and fails safe: if the holiday lookup errors we
 * fall back to the Friday-only rule (never crash a scheduler over it).
 *
 * Mirrors app-side isFridayDhaka() in src/agent/lib/agent-duties.ts.
 */

export function dhakaToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

export function dayOfWeekDhaka(now = new Date()) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Dhaka', weekday: 'short' }).format(now)
}

export function isFridayDhaka(now = new Date()) {
  return dayOfWeekDhaka(now) === 'Fri'
}

/**
 * Holiday dates ('YYYY-MM-DD', Dhaka) from AgentSettings. Read-only, fail-safe.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @returns {Promise<string[]>}
 */
export async function getHolidays(supabase) {
  try {
    const { data } = await supabase
      .from('AgentSettings')
      .select('holidays')
      .eq('id', 'global')
      .maybeSingle()
    const h = data?.holidays
    return Array.isArray(h) ? h.map((d) => String(d).slice(0, 10)) : []
  } catch (err) {
    console.warn('[off-day] holiday lookup failed, Friday-only fallback:', err?.message)
    return []
  }
}

/**
 * Is the office closed today? Friday OR a configured holiday.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {Date} [now]
 * @returns {Promise<{ off: boolean, reason: string|null }>}
 */
export async function isOfficeOffToday(supabase, now = new Date()) {
  if (isFridayDhaka(now)) return { off: true, reason: 'শুক্রবার — সাপ্তাহিক ছুটি' }
  const today = dhakaToday()
  const holidays = await getHolidays(supabase)
  if (holidays.includes(today)) return { off: true, reason: 'আজ ছুটির দিন (holiday)' }
  return { off: false, reason: null }
}

/**
 * Staff-facing "office is running" jobs that must NOT fire on an off-day.
 * Owner-personal jobs (todos, salah, briefings) are intentionally excluded.
 */
export const STAFF_OFFICE_JOBS = new Set([
  'morning-staff-reminder',
  'checkin-greeting',
  'day-shift-start',
  'day-shift-morning-brief',
  'day-shift-tick',
  'midday-checkin',
  'staff-morale',
  'staff-presence',
  'productivity-monitor',
  'geo-monitor',
  'lunch-watch',
  'ack-escalation',
  'staff-approval-escalation',
  'staff-performance',
  'proof-timeout',
])

/**
 * Notify the owner ONCE per off-day that the office is closed and the agent is
 * standing down staff duties. Uses an agent_kv_settings flag for idempotency.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {any} bot
 * @param {string} reason
 */
export async function notifyOwnerOfficeOffOnce(supabase, bot, reason) {
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!ownerChatId || !bot) return
  const key = `office_off_notified:${dhakaToday()}`
  try {
    const { data } = await supabase.from('agent_kv_settings').select('value').eq('key', key).maybeSingle()
    if (data?.value) return // already notified today
    await bot.telegram.sendMessage(
      ownerChatId,
      `🏖️ *আজ অফিস বন্ধ* — ${reason}.\n\n` +
        `স্টাফদের কোনো টাস্ক, রিমাইন্ডার বা মনিটরিং পাঠানো হবে না। কাল আবার স্বাভাবিক।`,
      { parse_mode: 'Markdown' },
    ).catch((err) => console.warn('[off-day] owner notice send failed:', err?.message))
    await supabase.from('agent_kv_settings').upsert(
      { key, value: new Date().toISOString() },
      { onConflict: 'key' },
    )
  } catch (err) {
    console.warn('[off-day] notifyOwnerOfficeOffOnce failed:', err?.message)
  }
}
