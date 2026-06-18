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
import { sendStaffNudge } from './staff-voice-nudge.mjs'
import { getCheckedInMap } from './attendance.mjs'
import { isStaffTaskEnabled } from './staff-toggle.mjs'
import { progressMarkup } from './progress-button.mjs'

const OWNER_CHAT_ID = () => process.env.TELEGRAM_OWNER_CHAT_ID
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

/**
 * agent_kv_settings.value is TEXT holding a JSON string (writes use
 * JSON.stringify). Reads MUST parse it — accessing `.foo` straight off the raw
 * value silently yields undefined, which broke per-day de-dup and made slow/idle
 * alerts re-fire on every 10-min tick. Tolerates an already-parsed object too.
 */
function parseKvValue(value) {
  if (value == null) return null
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return null }
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
  if (!(await isStaffTaskEnabled(supabase, 'proof_request'))) return []

  const today = dhakaToday()

  const { data: staffList } = await supabase
    .from('agent_staff')
    .select('id, name, telegramChatId, user_id')
    .eq('active', true)
    .eq('business_id', 'ALMA_LIFESTYLE')

  if (!staffList?.length) return []

  // Only ask staff who have actually checked in today.
  const checkedIn = await getCheckedInMap(supabase, staffList)
  const proofMarkup = await progressMarkup(supabase)

  const proofRequests = []

  for (const staff of staffList) {
    if (!staff.telegramChatId) continue
    if (!checkedIn.has(staff.id)) continue

    const kvKey = `proof_requests:${today}:${staff.id}`
    const { data: existing } = await supabase
      .from('agent_kv_settings')
      .select('value')
      .eq('key', kvKey)
      .maybeSingle()

    const proofsSentToday = parseKvValue(existing?.value)?.count ?? 0
    if (proofsSentToday >= PROOF_MAX_PER_DAY) continue

    const probability = 0.18
    if (Math.random() > probability) continue

    const textMessages = [
      'এখন কী করছেন? একটি ছবি পাঠান 📸',
      'কাজের আপডেট দিন — এখন কোন টাস্কে কাজ হচ্ছে?',
      'এখনকার কাজের একটি ছবি/স্ক্রিনশট পাঠান ✅',
      'আপনার বর্তমান কাজ সম্পর্কে একটু জানান — ছবি দিলে ভালো হয়।',
    ]
    const voiceScripts = [
      'এখন কাজ কতটুকু হয়েছে? একটি ছবি পাঠান।',
      'বর্তমান কাজের আপডেট দিন।',
      'কাজের একটি ছবি পাঠান।',
      'এখন কী করছেন? ছবি দিলে ভালো হয়।',
    ]
    const idx = randomInRange(0, textMessages.length - 1)
    const msg = textMessages[idx]
    const voiceScript = voiceScripts[idx]

    try {
      await sendStaffNudge(bot, staff.telegramChatId, msg, voiceScript, proofMarkup ?? undefined)
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

    if (bot && OWNER_CHAT_ID()) {
      await bot.telegram.sendMessage(OWNER_CHAT_ID(), msg, { parse_mode: 'Markdown' }).catch((e) => {
        console.warn('[productivity] proof timeout owner notify failed:', e.message)
      })
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
  if (!(await isStaffTaskEnabled(supabase, 'slow_task_alert'))) return

  const today = dhakaToday()
  const { data: tasks } = await supabase
    .from('staff_tasks')
    .select('id, staff_id, title, type, status, created_at, completed_at')
    .eq('proposed_for', today)
    .eq('status', 'sent')

  if (!tasks?.length) return

  // Resolve assigned staff once so we can anchor timing to attendance check-in.
  const staffIds = [...new Set(tasks.map((t) => t.staff_id).filter(Boolean))]
  const { data: staffRows } = await supabase
    .from('agent_staff')
    .select('id, name, telegramChatId, user_id')
    .in('id', staffIds)
  const staffById = new Map((staffRows ?? []).map((s) => [s.id, s]))
  const checkedIn = await getCheckedInMap(supabase, staffRows ?? [])

  const now = Date.now()
  const slowTasks = []

  for (const task of tasks) {
    const checkInTime = checkedIn.get(task.staff_id)
    // Count task time only after the staff has checked in. Not checked in → skip.
    if (!checkInTime) continue

    // Anchor on whichever is later: check-in or task creation.
    const startTime = Math.max(checkInTime.getTime(), new Date(task.created_at).getTime())
    const elapsedMinutes = (now - startTime) / 60_000
    const expectedMinutes = estimateTaskMinutes(task.type)
    const threshold = expectedMinutes * SLOW_TASK_MULTIPLIER

    if (elapsedMinutes > threshold) {
      const staffRow = staffById.get(task.staff_id)
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

  const alertedIds = new Set(parseKvValue(alerted?.value)?.taskIds ?? [])
  const newSlowTasks = slowTasks.filter((t) => !alertedIds.has(`${t.staffId}:${t.title}`))

  if (!newSlowTasks.length) return

  const slowMarkup = await progressMarkup(supabase)
  for (const task of newSlowTasks) {
    if (task.chatId) {
      const textNudge = `⏰ "${task.title}" — ${bnNum(task.elapsedMinutes)} মিনিট হয়ে গেছে। কতটুকু এগিয়েছে?`
      const firstName = task.staffName.split(/\s+/)[0] ?? 'ভাই'
      const voiceNudge = `${firstName} ভাই, "${task.title}" কতটুকু এগিয়েছে?`
      await sendStaffNudge(bot, task.chatId, textNudge, voiceNudge, slowMarkup ?? undefined).catch(() => {})
    }
    alertedIds.add(`${task.staffId}:${task.title}`)
  }

  if (bot && OWNER_CHAT_ID() && newSlowTasks.length > 0) {
    // Short one-line digest — names only, no per-task minute dumps.
    const names = [...new Set(newSlowTasks.map((t) => t.staffName))]
    const shown = names.slice(0, 3).join(', ')
    const more = names.length > 3 ? ` +${bnNum(names.length - 3)}` : ''
    await bot.telegram.sendMessage(
      OWNER_CHAT_ID(),
      `🐢 ধীর চলছে: ${shown}${more} — মনিটরে বিস্তারিত।`,
    ).catch((e) => {
      console.warn('[productivity] slow task owner notify failed:', e.message)
    })
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
  if (!(await isStaffTaskEnabled(supabase, 'idle_detect'))) return

  const today = dhakaToday()
  const { data: staffList } = await supabase
    .from('agent_staff')
    .select('id, name, telegramChatId, user_id')
    .eq('active', true)
    .eq('business_id', 'ALMA_LIFESTYLE')

  if (!staffList?.length) return

  // Idle detection only applies to staff who have checked in today.
  const checkedIn = await getCheckedInMap(supabase, staffList)

  const now = Date.now()
  const idleStaff = []

  for (const staff of staffList) {
    if (!checkedIn.has(staff.id)) continue
    const { data: recentOutbox } = await supabase
      .from('agent_outbox')
      .select('sent_at')
      .eq('staff_id', staff.id)
      .gte('sent_at', new Date(now - IDLE_THRESHOLD_MINUTES * 60_000).toISOString())
      .limit(1)

    const { data: recentTasks } = await supabase
      .from('staff_tasks')
      .select('completed_at')
      .eq('staff_id', staff.id)
      .eq('proposed_for', today)
      .eq('status', 'done')
      .order('completed_at', { ascending: false })
      .limit(1)

    const lastOutboxTime = recentOutbox?.[0]?.sent_at ? new Date(recentOutbox[0].sent_at).getTime() : 0
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

  const prevAlertedStaff = new Set(parseKvValue(prevAlert?.value)?.staffIds ?? [])
  const newIdle = idleStaff.filter((s) => !prevAlertedStaff.has(s.id))

  if (!newIdle.length) return

  const idleMarkup = await progressMarkup(supabase)
  for (const staff of newIdle) {
    if (staff.telegramChatId) {
      const textMessages = [
        'আপনার পরবর্তী কাজটি কতটুকু এগিয়েছে?',
        'কিছু সাহায্য লাগবে? অনেকক্ষণ ধরে কোনো আপডেট পাইনি।',
        'কাজ চলছে? একটু জানান 👍',
      ]
      const voiceMessages = [
        'কাজ কতটুকু এগিয়েছে?',
        'কিছু সাহায্য লাগবে?',
        'কাজ চলছে? একটু জানান।',
      ]
      const idx = randomInRange(0, textMessages.length - 1)
      await sendStaffNudge(bot, staff.telegramChatId, textMessages[idx], voiceMessages[idx], idleMarkup ?? undefined).catch(() => {})
    }
    prevAlertedStaff.add(staff.id)
  }

  if (bot && OWNER_CHAT_ID()) {
    const names = newIdle.map((s) => `${s.name} (${bnNum(s.idleMinutes)} min idle)`).join(', ')
    await bot.telegram.sendMessage(
      OWNER_CHAT_ID(),
      `😴 *Idle সনাক্ত:* ${names}\n\nনাজ পাঠানো হয়েছে।`,
      { parse_mode: 'Markdown' },
    ).catch((e) => {
      console.warn('[productivity] idle staff owner notify failed:', e.message)
    })
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

  const times = parseKvValue(existing?.value)?.times ?? []
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
