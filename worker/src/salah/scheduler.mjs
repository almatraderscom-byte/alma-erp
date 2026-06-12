/**
 * Salah Accountability Scheduler — SUB-PART D
 *
 * Responsibilities:
 * 1. At each azan time: create salah_record (pending) + send Tier 2 notification with inline buttons
 * 2. Within window: azan → prayer start (phone call) → +15min NTFY → call → grave messages
 * 3. On window close unconfirmed: mark 'missed' + Level 3 message
 * 4. Carryover: each azan first settles the previous pending waqt
 * 5. Tone ladder: Level 1 (warm) → Level 2 (firm Quran/Sunnah) → Level 3 (mortality + grief context)
 *
 * Called by the scheduler (BullMQ) via index.mjs.
 */

import { getPrayerTimes } from './times.mjs'
import { getDhakaSchedule } from './dhaka-schedule.mjs'
import { dhakaTodayYmd, dhakaNoonUtc, dhakaYesterdayYmd } from './dhaka-date.mjs'
import { isFridayDhaka } from './dhaka-schedule.mjs'
import {
  level1Message,
  level2Message,
  level3Message,
  missedMessage,
  salahChannelMessages,
} from './reminder-messages.mjs'
import { notify } from '../notify/index.mjs'

const APP_URL   = process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = process.env.AGENT_INTERNAL_TOKEN ?? ''

const WAQT_NAMES = {
  fajr:    'ফজর',
  dhuhr:   'যোহর',
  asr:     'আসর',
  maghrib: 'মাগরিব',
  isha:    'ইশা',
}

const WAQT_ORDER = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha']
const SETTLED_STATUSES = new Set(['prayed_on_time', 'prayed_late', 'qaza'])
/** 15 min after prayer start — NTFY if owner has not confirmed */
const PRAYER_NUDGE_MS = 15 * 60 * 1000
/** Friday jummah follow-up ~60 min after 1:30 PM prayer */
const JUMMAH_FOLLOWUP_MS = 60 * 60 * 1000

function isOwnerConfirmed(rec) {
  return SETTLED_STATUSES.has(rec.status) || Boolean(rec.confirmedAt)
}

function isPhantomConfirmation(confirmedAt, azanOrWindowStart) {
  if (!confirmedAt) return false
  const confirmed = new Date(confirmedAt)
  const start = new Date(azanOrWindowStart)
  return Number.isFinite(confirmed.getTime()) && Number.isFinite(start.getTime()) && confirmed < start
}

function shouldEscalateSalah(rec, azanOrWindowStart) {
  if (azanOrWindowStart && isPhantomConfirmation(rec.confirmedAt, azanOrWindowStart)) return true
  return rec.status === 'pending' && !rec.confirmedAt
}

function resolvePrayedStatus(windowEnd, now = new Date()) {
  return now <= windowEnd ? 'prayed_on_time' : 'prayed_late'
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function getSettings(keys) {
  const res = await fetch(`${APP_URL}/api/assistant/internal/agent-settings?keys=${keys.join(',')}`, {
    headers: { Authorization: `Bearer ${INT_TOKEN}` },
  })
  if (!res.ok) return {}
  return res.json()
}

async function upsertSalahRecord(data) {
  const res = await fetch(`${APP_URL}/api/assistant/internal/salah-record`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INT_TOKEN}` },
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => '(no body)')
    throw new Error(`salah-record ${res.status}: ${errText}`)
  }
  return res.json()
}

async function getSalahRecords(date) {
  const res = await fetch(`${APP_URL}/api/assistant/internal/salah-record?date=${date}`, {
    headers: { Authorization: `Bearer ${INT_TOKEN}` },
  })
  if (!res.ok) return []
  const data = await res.json()
  return data.records ?? []
}

// ── Override check ────────────────────────────────────────────────────────────

async function getSalahOverride(supabase, date, waqt) {
  const { data } = await supabase
    .from('salah_overrides')
    .select('*')
    .or(`date.is.null,date.eq.${date}`)
    .eq('waqt', waqt)
    .order('created_at', { ascending: false })
    .limit(1)
  return data?.[0] ?? null
}

function waqtDisplayName(waqt, prayerTimes) {
  return prayerTimes?.[waqt]?.label || WAQT_NAMES[waqt] || waqt
}

// ── Inline keyboard buttons ───────────────────────────────────────────────────

function salahButtons(waqt, dateYmd = null) {
  const d = dateYmd ? `:${dateYmd}` : ''
  return {
    inline_keyboard: [[
      { text: '✅ পড়েছি',    callback_data: `salah_done:${waqt}:prayed_on_time${d}` },
      { text: '🕐 পরে পড়বো', callback_data: `salah_later:${waqt}${d}` },
    ]],
  }
}

function qazaButtons(waqt, dateYmd = null) {
  const d = dateYmd ? `:${dateYmd}` : ''
  return {
    inline_keyboard: [[
      { text: '✅ কাযা পড়েছি', callback_data: `salah_done:${waqt}:qaza${d}` },
      { text: '😔 মিস হয়েছে',  callback_data: `salah_done:${waqt}:missed${d}` },
    ]],
  }
}

// ── Send azan notification ────────────────────────────────────────────────────

async function sendAzanNotification(bot, ownerChatId, waqt, prevPendingWaqt, settings, prayerTimes, dateYmd) {
  const name = waqtDisplayName(waqt, prayerTimes)
  const escalationLevel = parseInt(settings.salah_escalation_level ?? '2', 10)

  // First: settle previous pending waqt
  if (prevPendingWaqt) {
    const prevName = WAQT_NAMES[prevPendingWaqt] || prevPendingWaqt
    await bot.telegram.sendMessage(
      ownerChatId,
      `Sir, আগে বলুন — *${prevName}*-এর নামাজ কি পড়েছেন?`,
      {
        parse_mode: 'Markdown',
        reply_markup: qazaButtons(prevPendingWaqt),
      },
    )
    await new Promise(r => setTimeout(r, 1000))
  }

  const tier = escalationLevel >= 2 ? 2 : 1
  const msgs = salahChannelMessages({ tier: 1, waqt, waqtName: name, dateYmd, remindersSent: 0 })
  msgs.telegram = `🕌 *${name}-এর আযান হয়েছে*\n\n${msgs.telegram}`
  await notify({
    tier,
    title: `${name} আযান`,
    message: msgs.ntfy,
    category: 'salah',
    voice: true,
    voiceMessage: msgs.voice,
    skipTelegram: true,
    ntfyMode: tier >= 2 ? 'critical' : 'general',
  })
  await bot.telegram.sendMessage(ownerChatId, msgs.telegram, {
    parse_mode: 'Markdown',
    reply_markup: salahButtons(waqt),
  })
}

// API returns Prisma camelCase — tolerate legacy snake_case from older clients.
function normalizeSalahRecord(record) {
  return {
    waqt: record.waqt,
    status: record.status,
    windowStart: new Date(record.windowStart ?? record.window_start),
    windowEnd: new Date(record.windowEnd ?? record.window_end),
    confirmedAt: record.confirmedAt ?? record.confirmed_at ?? null,
    remindersSent: record.remindersSent ?? record.reminders_sent ?? 0,
  }
}

function isValidWindow(start, end) {
  return Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) && end > start
}

async function sendTelegramSafe(bot, ownerChatId, text, extra = {}) {
  if (!bot?.telegram || !ownerChatId) return
  try {
    await bot.telegram.sendMessage(ownerChatId, text, extra)
  } catch (err) {
    console.warn('[salah] telegram send failed:', err.message)
  }
}

/** Telegram (buttons) + optional ntfy + voice + optional Twilio call — one distinct copy per channel. */
async function deliverSalahAlert({
  tier,
  title,
  msgs,
  bot,
  ownerChatId,
  waqt,
  replyMarkup,
  withVoice = true,
  ntfyMode = 'critical',
}) {
  await notify({
    tier,
    title,
    message: msgs.ntfy,
    category: 'salah',
    voice: withVoice,
    voiceMessage: msgs.voice,
    skipTelegram: true,
    ntfyMode,
  })
  await sendTelegramSafe(
    bot,
    ownerChatId,
    msgs.telegram,
    { parse_mode: 'Markdown', reply_markup: replyMarkup ?? salahButtons(waqt) },
  )
}

// ── Escalation check (called on a schedule — e.g. every 5 min) ────────────────

export async function checkAndEscalateSalah({ supabase, bot }) {
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!ownerChatId) return

  const settings = await getSettings(['salah_escalation_level', 'salah_grief_reminder_enabled', 'salah_grief_context'])
  const escalationLevel = parseInt(settings.salah_escalation_level ?? '2', 10)
  const griefEnabled    = settings.salah_grief_reminder_enabled === 'true'
  const griefContext    = griefEnabled ? (settings.salah_grief_context ?? '') : ''

  const today       = dhakaTodayYmd()
  let records       = await getSalahRecords(today)
  const now         = new Date()
  const prayerTimes = await getPrayerTimes(dhakaNoonUtc(today))
  const schedule    = await getDhakaSchedule(today)
  const waqtName    = (waqt) => waqtDisplayName(waqt, prayerTimes)

  // Heal rows where owner confirmed but status is still pending/missed (race with escalation).
  for (const raw of records) {
    const rec = normalizeSalahRecord(raw)
    if (rec.confirmedAt && !SETTLED_STATUSES.has(rec.status)) {
      const healed = resolvePrayedStatus(rec.windowEnd, now)
      await upsertSalahRecord({ date: today, waqt: rec.waqt, status: healed })
      raw.status = healed
    }
  }

  // Stale DB windows (wrong day / bad adhan) — re-init instead of mass "missed" flood
  const pendingPastEnd = records.filter((r) => {
    const rec = normalizeSalahRecord(r)
    return rec.status === 'pending' && now > rec.windowEnd
  })
  if (pendingPastEnd.length >= 2) {
    const stale = pendingPastEnd.filter((r) => {
      const rec = normalizeSalahRecord(r)
      const exp = prayerTimes[rec.waqt]
      if (!exp) return true
      return Math.abs(rec.windowStart - exp.start) > 2 * 60 * 60 * 1000
    })
    if (stale.length >= 2) {
      console.warn(`[salah] stale windows (${stale.length}) — re-initializing ${today}`)
      await initializeDailySalahRecords(supabase)
      records = await getSalahRecords(today)
    }
  }

  // Fajr carryover: ask about yesterday's pending waqts once per morning
  const fajrRecord = records.find((r) => r.waqt === 'fajr')
  if (fajrRecord) {
    const fajr = normalizeSalahRecord(fajrRecord)
    const msSinceFajr = now - fajr.windowStart
    if (fajr.status === 'pending' && msSinceFajr >= 0 && msSinceFajr < 6 * 60 * 1000 && fajr.remindersSent === 0) {
      const yesterday = dhakaYesterdayYmd()
      const yRecords = await getSalahRecords(yesterday)
      for (const yr of yRecords) {
        const y = normalizeSalahRecord(yr)
        if (!isOwnerConfirmed(y)) {
          const prevName = WAQT_NAMES[y.waqt] || y.waqt
          await sendTelegramSafe(
            bot,
            ownerChatId,
            `Sir, গতকাল *${prevName}*-এর নামাজ পড়েছেন কি?`,
            { parse_mode: 'Markdown', reply_markup: qazaButtons(y.waqt, yesterday) },
          )
        }
      }
    }
  }

  for (const raw of records) {
    let record = normalizeSalahRecord(raw)
    const { windowEnd, waqt } = record
    let { windowStart } = record
    let remindersSent = record.remindersSent

    const waqtScheduleEarly = schedule[waqt] ?? prayerTimes[waqt]
    const azanTimeEarly = new Date(waqtScheduleEarly?.azan ?? windowStart)

    // Agent/LLM sometimes marks Maghrib/Isha before azan — heal and resume reminders.
    if (
      isPhantomConfirmation(record.confirmedAt, azanTimeEarly)
      && now >= azanTimeEarly
      && record.status !== 'pending'
    ) {
      console.warn(`[salah] phantom confirmation for ${waqt} — reopening for reminders`)
      await upsertSalahRecord({ date: today, waqt, reopen: true })
      record = { ...record, status: 'pending', confirmedAt: null }
      raw.status = 'pending'
    }

    if (!shouldEscalateSalah(record, azanTimeEarly)) continue

    if (!isValidWindow(windowStart, windowEnd)) {
      console.warn(`[salah] skip invalid window for ${waqt} on ${today}`)
      continue
    }

    // Overrides set after today's init ("আজ Dhuhr ২:৩০ এ পড়বো") must take
    // effect on this run, not tomorrow's init.
    const override = await getSalahOverride(supabase, today, waqt)
    if (override?.skip) continue
    const overrideStart = override?.override_time
      ? new Date(override.override_time)
      : override?.delay_until
        ? new Date(override.delay_until)
        : null
    if (overrideStart && Number.isFinite(overrideStart.getTime()) && overrideStart < windowEnd) {
      windowStart = overrideStart
    }

    // Future waqt — do not remind or mark missed
    if (now < windowStart) continue

    const waqtSchedule = schedule[waqt] ?? prayerTimes[waqt]
    const azanTime = new Date(waqtSchedule?.azan ?? windowStart)
    const prayerStart = new Date(waqtSchedule?.prayerStart ?? windowStart)
    const msSinceAzan = now - azanTime
    const msSincePrayerStart = now - prayerStart

    // Step 0: Azan — Quran/Hadith reminder
    if (msSinceAzan >= 0 && remindersSent === 0 && now < windowEnd) {
      const name = waqtName(waqt)
      const msgs = salahChannelMessages({
        tier: 1,
        waqt,
        waqtName: name,
        dateYmd: today,
        remindersSent,
      })
      msgs.telegram = `🕌 *${name}-এর আযান হয়েছে*\n\n${msgs.telegram}`
      await deliverSalahAlert({
        tier: escalationLevel >= 2 ? 2 : 1,
        title: `${name} আযান`,
        msgs,
        bot,
        ownerChatId,
        waqt,
        ntfyMode: escalationLevel >= 2 ? 'critical' : 'general',
      })

      const prevIdx = WAQT_ORDER.indexOf(waqt) - 1
      if (prevIdx >= 0) {
        const prevWaqt = WAQT_ORDER[prevIdx]
        const prevRaw = records.find((r) => r.waqt === prevWaqt)
        if (prevRaw) {
          const prev = normalizeSalahRecord(prevRaw)
          if (shouldEscalateSalah(prev) && now > prev.windowEnd) {
            await sendTelegramSafe(
              bot,
              ownerChatId,
              `Sir, আগে বলুন — *${WAQT_NAMES[prevWaqt]}*-এর নামাজ পড়েছেন কি?`,
              { parse_mode: 'Markdown', reply_markup: qazaButtons(prevWaqt) },
            )
          }
        }
      }

      await upsertSalahRecord({ date: today, waqt, incrementReminders: true })
      continue
    }

    // Step 1: Prayer start — direct phone call + NTFY + Telegram (no SMS)
    if (msSincePrayerStart >= 0 && remindersSent === 1 && now < windowEnd) {
      const name = waqtName(waqt)
      const msgs = salahChannelMessages({
        tier: 2,
        waqt,
        waqtName: name,
        dateYmd: today,
        remindersSent,
      })
      msgs.telegram = `⏰ *${name} — নামাজের সময়*\n\n${msgs.telegram}`
      await deliverSalahAlert({
        tier: 3,
        title: `${name} — নামাজের সময়`,
        msgs,
        bot,
        ownerChatId,
        waqt,
        ntfyMode: 'critical',
      })
      await upsertSalahRecord({ date: today, waqt, incrementReminders: true })
      continue
    }

    // Friday Jummah: follow-up ~60 min after 1:30 PM prayer
    if (
      waqt === 'dhuhr'
      && isFridayDhaka(today)
      && msSincePrayerStart >= JUMMAH_FOLLOWUP_MS
      && now < windowEnd
      && remindersSent === 2
    ) {
      const name = waqtName(waqt)
      const msgs = salahChannelMessages({
        tier: 2,
        waqt,
        waqtName: name,
        dateYmd: today,
        remindersSent,
      })
      msgs.telegram = `Sir, জুম্মার সময় পার — *${name}* পড়েছেন কি?\n\n${msgs.telegram}`
      await deliverSalahAlert({
        tier: escalationLevel >= 2 ? 2 : 1,
        title: `${name} — জুম্মা follow-up`,
        msgs,
        bot,
        ownerChatId,
        waqt,
        ntfyMode: 'critical',
      })
      await upsertSalahRecord({ date: today, waqt, incrementReminders: true })
      continue
    }

    // Step 2: 15 min after prayer start — NTFY critical if not confirmed
    if (
      msSincePrayerStart >= PRAYER_NUDGE_MS
      && remindersSent === 2
      && now < windowEnd
      && !(waqt === 'dhuhr' && isFridayDhaka(today))
    ) {
      const name = waqtName(waqt)
      const msgs = salahChannelMessages({
        tier: 2,
        waqt,
        waqtName: name,
        dateYmd: today,
        remindersSent,
      })
      msgs.telegram = `Sir, ${name} — এখনো confirm করেননি। "পড়েছি" বলুন বা বাটন চাপুন।\n\n${msgs.telegram}`
      await deliverSalahAlert({
        tier: 2,
        title: `${name} — এখনো পড়েননি?`,
        msgs,
        bot,
        ownerChatId,
        waqt,
        withVoice: false,
        ntfyMode: 'critical',
      })
      await upsertSalahRecord({ date: today, waqt, incrementReminders: true })
      continue
    }

    // Step 3: Emotional voice call
    if (msSincePrayerStart >= PRAYER_NUDGE_MS && remindersSent === 3 && now < windowEnd) {
      const name = waqtName(waqt)
      const msgs = salahChannelMessages({
        tier: 3,
        waqt,
        waqtName: name,
        dateYmd: today,
        remindersSent,
        griefContext,
      })
      msgs.telegram = `🚨 *${name} — Sir, উঠুন*\n\n${msgs.telegram}`
      await deliverSalahAlert({
        tier: 3,
        title: `${name} — Sir, উঠুন`,
        msgs,
        bot,
        ownerChatId,
        waqt,
        ntfyMode: 'critical',
      })
      await upsertSalahRecord({ date: today, waqt, incrementReminders: true })
      continue
    }

    // Step 4+: Grave / kabir azab — personal, until window ends
    if (msSincePrayerStart >= PRAYER_NUDGE_MS && remindersSent >= 4 && remindersSent <= 8 && now < windowEnd) {
      const name = waqtName(waqt)
      const msgs = salahChannelMessages({
        tier: 3,
        waqt,
        waqtName: name,
        dateYmd: today,
        remindersSent,
        griefContext,
      })
      msgs.telegram = `⚰️ *${name} — Sir, শুনুন*\n\n${msgs.telegram}`
      await deliverSalahAlert({
        tier: 3,
        title: `${name} — কবরের কথা`,
        msgs,
        bot,
        ownerChatId,
        waqt,
        ntfyMode: 'critical',
      })
      await upsertSalahRecord({ date: today, waqt, incrementReminders: true })
      continue
    }

    // Window closed → mark missed (phantom early marks do not count as confirmed)
    if (now > windowEnd) {
      if (record.confirmedAt && !isPhantomConfirmation(record.confirmedAt, azanTimeEarly)) continue
      await upsertSalahRecord({ date: today, waqt, status: 'missed' })

      const name = waqtName(waqt)
      const missedTier = escalationLevel >= 2 ? 3 : 2
      const msgs = salahChannelMessages({
        tier: 'missed',
        waqt,
        waqtName: name,
        dateYmd: today,
        remindersSent,
        griefContext,
      })
      msgs.telegram = `❌ ${name}-এর ওয়াক্ত শেষ\n\n${msgs.telegram}`
      await deliverSalahAlert({
        tier: missedTier,
        title: `${name} window ended`,
        msgs,
        bot,
        ownerChatId,
        waqt,
        replyMarkup: qazaButtons(waqt),
        withVoice: missedTier >= 3,
        ntfyMode: 'critical',
      })
      continue
    }
  }
}

// ── Initialize today's salah records at dawn ──────────────────────────────────

export async function initializeDailySalahRecords(supabase) {
  const today = dhakaTodayYmd()
  const times = await getPrayerTimes(dhakaNoonUtc(today))

  for (const waqt of WAQT_ORDER) {
    const prayerWindow = times[waqt]
    if (!prayerWindow) continue

    // Check for override
    const { data: override } = await supabase
      .from('salah_overrides')
      .select('*')
      .or(`date.is.null,date.eq.${today}`)
      .eq('waqt', waqt)
      .order('created_at', { ascending: false })
      .limit(1)

    const ov = override?.[0]
    if (ov?.skip) {
      console.log(`[salah] ${waqt} skipped via override`)
      continue
    }

    const waqtStart = ov?.override_time
      ? new Date(ov.override_time)
      : ov?.delay_until
        ? new Date(ov.delay_until)
        : prayerWindow.start

    await upsertSalahRecord({
      date:        today,
      waqt:        waqt,
      windowStart: waqtStart.toISOString(),
      windowEnd:   prayerWindow.end.toISOString(),
      status:      'pending',
      resetDay:    true,
    })
    console.log(`[salah] initialized ${waqt} for ${today}`)
  }

  console.log(`[salah] initialized salah records for ${today} — done`)
}

// ── Handle Telegram salah button callbacks ────────────────────────────────────

export async function handleSalahCallback(ctx, action, waqt, status, dateYmd = null) {
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!ownerChatId || String(ctx.chat?.id) !== ownerChatId) return

  const recordDate = dateYmd || dhakaTodayYmd()

  if (action === 'salah_done') {
    const dayRecords = await getSalahRecords(recordDate)
    const existing = dayRecords.find((r) => r.waqt === waqt)
    const windowEnd = existing
      ? new Date(existing.windowEnd ?? existing.window_end)
      : null
    const resolved = status === 'prayed_on_time' && windowEnd
      ? resolvePrayedStatus(windowEnd)
      : status
    await upsertSalahRecord({ date: recordDate, waqt, status: resolved })
    const messages = {
      prayed_on_time: `✅ আলহামদুলিল্লাহ, ${WAQT_NAMES[waqt]} পড়েছেন। আল্লাহ কবুল করুন।`,
      prayed_late:    `✅ আলহামদুলিল্লাহ। পরের ওয়াক্ত সময়মতো পড়ার চেষ্টা করুন।`,
      qaza:           `✅ কাযা পড়া হয়েছে — আল্লাহ কবুল করুন।`,
      missed:         `😔 আল্লাহ মাফ করুন। পরের ওয়াক্ত মিস করবেন না।`,
    }
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {})
    await ctx.answerCbQuery(messages[resolved] || 'আপডেট হয়েছে')
    await ctx.reply(messages[resolved] || 'রেকর্ড আপডেট হয়েছে।')
  } else if (action === 'salah_later') {
    await ctx.answerCbQuery('ঠিক আছে — মনে করিয়ে দেব।')
    await ctx.reply(`ঠিক আছে Sir। সময়মতো পড়বেন — ${WAQT_NAMES[waqt]}-এর সময় শেষ হওয়ার আগেই পড়ুন।`)
  }
}

export { WAQT_NAMES }
export { level1Message, level2Message, level3Message, missedMessage } from './reminder-messages.mjs'
