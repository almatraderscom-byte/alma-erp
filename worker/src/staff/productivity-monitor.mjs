/**
 * Staff Productivity Surveillance — the "always watching" system.
 *
 * Features:
 *  1. Random proof-of-work requests (2-4x per day per staff)
 *  2. Task timing analysis (flag slow tasks)
 *  3. Response time scoring per staff
 *  4. Idle detection + psychological presence messages
 *  5. Weekly productivity scorecard
 *
 * Runs every 10 min during office hours. Sub-checks fire on probability.
 */
import { isWithinOfficeHours } from './office-hours.mjs'
import { notify } from '../notify/index.mjs'
import { bnNum, formatDhakaTimeBn } from './bn-format.mjs'

const OWNER_CHAT_ID = process.env.OWNER_TELEGRAM_CHAT_ID
const PROOF_MAX_PER_DAY = 4
const PROOF_REPLY_TIMEOUT_MS = 5 * 60 * 1000
const IDLE_THRESHOLD_MINUTES = 120
const SLOW_TASK_MULTIPLIER = 2.5

const TASK_DURATION_ESTIMATES = {
  content_creative: 45,
  ad_creative: 30,
  photo_shoot: 60,
  video_reel: 90,
  listing_update: 20,
  caption_hashtag: 15,
  order_followup: 20,
  cover_update: 15,
  story_update: 10,
  default: 40,
}

function estimateTaskMinutes(taskType) {
  return TASK_DURATION_ESTIMATES[taskType] || TASK_DURATION_ESTIMATES.default
}

function dhakaToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

function randomInRange(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

/**
 * Random proof-of-work — asks staff for a photo of current work.
 * Fires probabilistically (each 10-min run has ~20% chance per staff).
 */
export async function maybeRequestProof(context) {
  const { supabase, bot } = context
  if (!isWithinOfficeHours()) return []

  const today = dhakaToday()

  const { data: staffList } = await supabase
    .from('agent_staff')
    .select('id, name, telegramChatId')
    .eq('active', true)
    .eq('businessId', 'ALMA_LIFESTYLE')

  if (!staffList?.length) return []

  const proofRequests = []

  for (const staff of staffList) {
    if (!staff.telegramChatId) continue

    const kvKey = `proof_requests:${today}:${staff.id}`
    const { data: existing } = await supabase
      .from('agent_kv_settings')
      .select('value')
      .eq('key', kvKey)
      .maybeSingle()

    const proofsSentToday = existing?.value?.count ?? 0
    if (proofsSentToday >= PROOF_MAX_PER_DAY) continue

    const probability = 0.18
    if (Math.random() > probability) continue

    const messages = [
      'এখন কী করছেন? একটি ছবি পাঠান 📸',
      'কাজের আপডেট দিন — এখন কোন টাস্কে কাজ হচ্ছে?',
      'এখনকার কাজের একটি ছবি/স্ক্রিনশট পাঠান ✅',
      'আপনার বর্তমান কাজ সম্পর্কে একটু জানান — ছবি দিলে ভালো হয়।',
    ]
    const msg = messages[randomInRange(0, messages.length - 1)]

    try {
      await bot.telegram.sendMessage(staff.telegramChatId, msg)
      proofRequests.push({ staffId: staff.id, staffName: staff.name, sentAt: new Date().toISOString() })

      await supabase.from('agent_kv_settings').upsert({
        key: kvKey,
        value: JSON.stringify({ count: proofsSentToday + 1, lastSentAt: new Date().toISOString() }),
        updated_at: new Date().toISOString(),
      })

      const timeoutKey = `proof_pending:${staff.id}`
      await supabase.from('agent_kv_settings').upsert({
        key: timeoutKey,
        value: JSON.stringify({ sentAt: Date.now(), staffName: staff.name, chatId: staff.telegramChatId }),
        updated_at: new Date().toISOString(),
      })
    } catch (err) {
      console.warn(`[productivity] proof request to ${staff.name} failed:`, err.message)
    }
  }

  return proofRequests
}

/**
 * Check for expired proof requests (staff didn't reply within 5 min).
 */
export async function checkProofTimeouts(context) {
  const { supabase, bot } = context

  const { data: pending } = await supabase
    .from('agent_kv_settings')
    .select('key, value')
    .like('key', 'proof_pending:%')

  if (!pending?.length) return

  const now = Date.now()

  for (const row of pending) {
    let parsed
    try { parsed = JSON.parse(row.value) } catch { continue }
    if (!parsed.sentAt) continue

    const elapsed = now - parsed.sentAt
    if (elapsed < PROOF_REPLY_TIMEOUT_MS) continue

    const staffName = parsed.staffName ?? 'স্টাফ'
    const msg = `⚠️ *${staffName}* — ৫ মিনিটে কাজের ছবি/আপডেট পাঠায়নি। সম্ভবত কাজে ব্যস্ত নয়।`

    if (bot && OWNER_CHAT_ID) {
      await bot.telegram.sendMessage(OWNER_CHAT_ID, msg, { parse_mode: 'Markdown' }).catch(() => {})
    }

    await supabase.from('agent_kv_settings').delete().eq('key', row.key)
  }
}

/**
 * Mark proof as received (called from Telegram message handler when staff sends photo/text after proof request).
 */
export async function markProofReceived(supabase, staffId) {
  const key = `proof_pending:${staffId}`
  await supabase.from('agent_kv_settings').delete().eq('key', key)
}

/**
 * Task timing analysis — detect unusually slow tasks.
 */
export async function analyzeTaskTiming(context) {
  const { supabase, bot } = context
  if (!isWithinOfficeHours()) return

  const today = dhakaToday()
  const { data: tasks } = await supabase
    .from('staff_tasks')
    .select('id, staff_id, title, type, status, created_at, completed_at')
    .eq('proposed_for', today)
    .eq('status', 'sent')

  if (!tasks?.length) return

  const now = Date.now()
  const slowTasks = []

  for (const task of tasks) {
    const startTime = new Date(task.created_at).getTime()
    const elapsedMinutes = (now - startTime) / 60_000
    const expectedMinutes = estimateTaskMinutes(task.type)
    const threshold = expectedMinutes * SLOW_TASK_MULTIPLIER

    if (elapsedMinutes > threshold) {
      const { data: staffRow } = await supabase
        .from('agent_staff')
        .select('name, telegramChatId')
        .eq('id', task.staff_id)
        .maybeSingle()

      slowTasks.push({
        staffName: staffRow?.name ?? 'অজানা',
        chatId: staffRow?.telegramChatId,
        title: task.title,
        elapsedMinutes: Math.round(elapsedMinutes),
        expectedMinutes,
        staffId: task.staff_id,
      })
    }
  }

  if (!slowTasks.length) return

  const alertKey = `slow_task_alert:${today}`
  const { data: alerted } = await supabase
    .from('agent_kv_settings')
    .select('value')
    .eq('key', alertKey)
    .maybeSingle()

  const alertedIds = new Set(alerted?.value?.taskIds ?? [])
  const newSlowTasks = slowTasks.filter((t) => !alertedIds.has(`${t.staffId}:${t.title}`))

  if (!newSlowTasks.length) return

  for (const task of newSlowTasks) {
    if (task.chatId) {
      const nudge = `⏰ "${task.title}" — ${bnNum(task.elapsedMinutes)} মিনিট হয়ে গেছে। কতটুকু এগিয়েছে?`
      await bot.telegram.sendMessage(task.chatId, nudge).catch(() => {})
    }
    alertedIds.add(`${task.staffId}:${task.title}`)
  }

  if (bot && OWNER_CHAT_ID && newSlowTasks.length > 0) {
    const lines = newSlowTasks.map((t) =>
      `• ${t.staffName}: "${t.title}" (${bnNum(t.elapsedMinutes)} min, expected ${bnNum(t.expectedMinutes)})`
    ).join('\n')
    await bot.telegram.sendMessage(
      OWNER_CHAT_ID,
      `🐢 *ধীর কাজ সনাক্ত:*\n${lines}`,
      { parse_mode: 'Markdown' },
    ).catch(() => {})
  }

  await supabase.from('agent_kv_settings').upsert({
    key: alertKey,
    value: JSON.stringify({ taskIds: [...alertedIds] }),
    updated_at: new Date().toISOString(),
  })
}

/**
 * Idle detection — if no task updates, no messages, no proof for 2+ hours, alert owner.
 */
export async function detectIdleStaff(context) {
  const { supabase, bot } = context
  if (!isWithinOfficeHours()) return

  const today = dhakaToday()
  const { data: staffList } = await supabase
    .from('agent_staff')
    .select('id, name, telegramChatId')
    .eq('active', true)
    .eq('businessId', 'ALMA_LIFESTYLE')

  if (!staffList?.length) return

  const now = Date.now()
  const idleStaff = []

  for (const staff of staffList) {
    const { data: recentOutbox } = await supabase
      .from('agent_outbox')
      .select('delivered_at')
      .eq('target_staff_id', staff.id)
      .gte('delivered_at', new Date(now - IDLE_THRESHOLD_MINUTES * 60_000).toISOString())
      .limit(1)

    const { data: recentTasks } = await supabase
      .from('staff_tasks')
      .select('completed_at')
      .eq('staff_id', staff.id)
      .eq('proposed_for', today)
      .eq('status', 'done')
      .order('completed_at', { ascending: false })
      .limit(1)

    const lastOutboxTime = recentOutbox?.[0]?.delivered_at ? new Date(recentOutbox[0].delivered_at).getTime() : 0
    const lastTaskDone = recentTasks?.[0]?.completed_at ? new Date(recentTasks[0].completed_at).getTime() : 0
    const lastActivity = Math.max(lastOutboxTime, lastTaskDone)
    const idleMinutes = lastActivity > 0 ? Math.round((now - lastActivity) / 60_000) : null

    if (idleMinutes != null && idleMinutes > IDLE_THRESHOLD_MINUTES) {
      idleStaff.push({ ...staff, idleMinutes })
    }
  }

  if (!idleStaff.length) return

  const idleAlertKey = `idle_alert:${today}`
  const { data: prevAlert } = await supabase
    .from('agent_kv_settings')
    .select('value')
    .eq('key', idleAlertKey)
    .maybeSingle()

  const prevAlertedStaff = new Set(prevAlert?.value?.staffIds ?? [])
  const newIdle = idleStaff.filter((s) => !prevAlertedStaff.has(s.id))

  if (!newIdle.length) return

  for (const staff of newIdle) {
    if (staff.telegramChatId) {
      const presenceMsg = [
        'আপনার পরবর্তী কাজটি কতটুকু এগিয়েছে?',
        'কিছু সাহায্য লাগবে? অনেকক্ষণ ধরে কোনো আপডেট পাইনি।',
        'কাজ চলছে? একটু জানান 👍',
      ]
      const msg = presenceMsg[randomInRange(0, presenceMsg.length - 1)]
      await bot.telegram.sendMessage(staff.telegramChatId, msg).catch(() => {})
    }
    prevAlertedStaff.add(staff.id)
  }

  if (bot && OWNER_CHAT_ID) {
    const names = newIdle.map((s) => `${s.name} (${bnNum(s.idleMinutes)} min idle)`).join(', ')
    await bot.telegram.sendMessage(
      OWNER_CHAT_ID,
      `😴 *Idle সনাক্ত:* ${names}\n\nনাজ পাঠানো হয়েছে।`,
      { parse_mode: 'Markdown' },
    ).catch(() => {})
  }

  await supabase.from('agent_kv_settings').upsert({
    key: idleAlertKey,
    value: JSON.stringify({ staffIds: [...prevAlertedStaff] }),
    updated_at: new Date().toISOString(),
  })
}

/**
 * Response time tracker — records how fast staff reply to bot messages.
 * Called from the Telegram message handler.
 */
export async function recordStaffResponseTime(supabase, staffId, messageId, repliedAt) {
  const key = `response_times:${dhakaToday()}:${staffId}`
  const { data: existing } = await supabase
    .from('agent_kv_settings')
    .select('value')
    .eq('key', key)
    .maybeSingle()

  const times = existing?.value?.times ?? []
  times.push({ messageId, repliedAt, replyMs: repliedAt - Date.now() })

  await supabase.from('agent_kv_settings').upsert({
    key,
    value: JSON.stringify({ times, avgMs: times.reduce((s, t) => s + Math.abs(t.replyMs), 0) / times.length }),
    updated_at: new Date().toISOString(),
  })
}

/**
 * Main runner — called from scheduler every 10 minutes.
 */
export async function runProductivityMonitor(context) {
  if (!isWithinOfficeHours()) {
    return { dutyStatus: 'skipped', dutyDetail: 'outside office hours' }
  }

  const results = []

  try {
    const proofs = await maybeRequestProof(context)
    if (proofs.length) results.push(`proof_requests:${proofs.length}`)
  } catch (err) {
    console.warn('[productivity] proof request error:', err.message)
  }

  try {
    await checkProofTimeouts(context)
  } catch (err) {
    console.warn('[productivity] proof timeout check error:', err.message)
  }

  try {
    await analyzeTaskTiming(context)
  } catch (err) {
    console.warn('[productivity] task timing error:', err.message)
  }

  try {
    await detectIdleStaff(context)
  } catch (err) {
    console.warn('[productivity] idle detection error:', err.message)
  }

  return { dutyStatus: 'done', dutyDetail: results.join(', ') || 'no action needed' }
}
