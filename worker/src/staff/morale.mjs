/**
 * Daily staff morale — one warm message per staff per day (office hours).
 */

import { loggedSendToStaff } from '../telegram/logged-send.mjs'
import { pickMoraleMessage, shouldUseAdaptiveMorale } from './morale-messages.mjs'
import { isWithinOfficeHours } from './office-hours.mjs'
import { isStaffOnLeaveSb } from './leave.mjs'

const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

function dhakaToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

async function alreadySentToday(supabase, staffId, today) {
  const dayStart = `${today}T00:00:00+06:00`
  const { data } = await supabase
    .from('agent_outbox')
    .select('id')
    .eq('staff_id', staffId)
    .eq('type', 'morale')
    .gte('created_at', dayStart)
    .limit(1)
  return (data?.length ?? 0) > 0
}

async function buildRecentContext(supabase, staffId) {
  const today = dhakaToday()
  const { data: tasks } = await supabase
    .from('staff_tasks')
    .select('title, status, type')
    .eq('staff_id', staffId)
    .eq('proposed_for', today)
    .not('status', 'eq', 'cancelled')

  if (!tasks?.length) return 'আজ এখনো কোনো টাস্ক অ্যাসাইন হয়নি।'

  const work = tasks.filter((t) => t.type !== 'learning')
  const done = work.filter((t) => t.status === 'done')
  const pending = work.filter((t) => !['done', 'cancelled'].includes(t.status))

  const lines = [`আজ ${done.length}/${work.length} কাজ সম্পন্ন (এখন পর্যন্ত)।`]
  if (done.length > 0) {
    lines.push(`শেষ করা: ${done.map((t) => t.title).slice(0, 3).join(', ')}`)
  }
  if (pending.length > 0 && done.length < work.length) {
    lines.push(`বাকি: ${pending.map((t) => t.title).slice(0, 2).join(', ')}`)
  }
  return lines.join(' ')
}

async function fetchAdaptiveMorale(staffName, recentContext) {
  const url = APP_URL()
  const token = INT_TOKEN()
  if (!url || !token) return null

  try {
    const res = await fetch(`${url}/api/assistant/internal/morale-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ staffName, recentContext }),
    })
    if (!res.ok) {
      console.warn(`[staff-morale] adaptive API HTTP ${res.status}`)
      return null
    }
    const data = await res.json().catch(() => ({}))
    const text = typeof data.message === 'string' ? data.message.trim() : ''
    return text || null
  } catch (err) {
    console.warn('[staff-morale] adaptive fetch failed:', err.message)
    return null
  }
}

export async function runStaffMorale({ supabase, bot }) {
  if (!bot || !isWithinOfficeHours('ALMA_LIFESTYLE')) {
    return { dutyStatus: 'skipped', dutyDetail: 'office hours বাইরে বা bot নেই' }
  }

  const dayIndex = Math.floor(Date.now() / 86_400_000)
  const today = dhakaToday()
  const useAdaptive = shouldUseAdaptiveMorale(dayIndex)

  const { data: staff } = await supabase
    .from('agent_staff')
    .select('id, name, telegramChatId')
    .eq('active', true)

  let sent = 0
  let skipped = 0
  let sendFails = 0

  for (const s of staff ?? []) {
    if (!s.telegramChatId) {
      skipped++
      continue
    }
    if (await alreadySentToday(supabase, s.id, today)) {
      skipped++
      continue
    }
    if (await isStaffOnLeaveSb(supabase, s.id, today)) {
      skipped++
      continue
    }

    let msg = pickMoraleMessage(dayIndex, s.name)
    if (useAdaptive) {
      const recentContext = await buildRecentContext(supabase, s.id)
      const adaptive = await fetchAdaptiveMorale(s.name, recentContext)
      if (adaptive) msg = adaptive
    }

    const result = await loggedSendToStaff(bot.telegram, {
      supabase,
      staffId: s.id,
      staffName: s.name,
      businessId: 'ALMA_LIFESTYLE',
      type: 'morale',
      content: msg,
      chatId: s.telegramChatId,
      officeHoursOnly: true,
      requiresAck: false,
    }).catch((err) => {
      console.warn(`[staff-morale] send failed for ${s.name}:`, err.message)
      sendFails++
      return { ok: false }
    })

    if (result?.ok) sent++
    else skipped++
  }

  if (sendFails > 0 && sent === 0 && (staff?.length ?? 0) > 0) {
    const ownerChat = process.env.TELEGRAM_OWNER_CHAT_ID
    if (ownerChat && bot) {
      await bot.telegram.sendMessage(ownerChat,
        `⚠️ Staff morale বার্তা পাঠানো সম্পূর্ণ ব্যর্থ — ${sendFails}টি ব্যর্থ, ০ সফল। Telegram সমস্যা হতে পারে।`,
      ).catch((e) => console.error('[staff-morale] owner escalation failed:', e.message))
    }
  }

  console.log(`[staff-morale] sent=${sent} skipped=${skipped} sendFails=${sendFails} adaptive=${useAdaptive}`)
  return {
    dutyStatus: sent > 0 ? 'done' : 'skipped',
    dutyDetail: sent > 0 ? `${sent} জনকে পাঠানো` : `কাউকে পাঠানো হয়নি (${sendFails} ব্যর্থ)`,
  }
}
