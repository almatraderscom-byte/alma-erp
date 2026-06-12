/**
 * Salah Accountability Scheduler — SUB-PART D
 *
 * Responsibilities:
 * 1. At each azan time: create salah_record (pending) + send Tier 2 notification with inline buttons
 * 2. Within window: escalating follow-ups at 40%, 70%, 90% of window
 * 3. On window close unconfirmed: mark 'missed' + Level 3 message
 * 4. Carryover: each azan first settles the previous pending waqt
 * 5. Tone ladder: Level 1 (warm) → Level 2 (firm Quran/Sunnah) → Level 3 (mortality + grief context)
 *
 * Called by the scheduler (BullMQ) via index.mjs.
 */

import { getPrayerTimes, windowProgress } from './times.mjs'
import { dhakaTodayYmd, dhakaNoonUtc, dhakaYesterdayYmd } from './dhaka-date.mjs'
import {
  level1Message,
  level2Message,
  level3Message,
  missedMessage,
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

function isOwnerConfirmed(rec) {
  return SETTLED_STATUSES.has(rec.status) || Boolean(rec.confirmedAt)
}

function shouldEscalateSalah(rec) {
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

  // Send azan notification (Tier 2 by default)
  const tier = escalationLevel >= 2 ? 2 : 1
  const text = level1Message(waqt, name, dateYmd, 0)

  await notify({
    tier,
    title:    `🕌 ${name}-এর আযান`,
    message:  text,
    category: 'salah',
    voice:    true,
    skipTelegram: true,
  })

  // Also send Telegram with buttons
  await bot.telegram.sendMessage(
    ownerChatId,
    `🕌 *${name}-এর আযান হয়েছে*\n\n${text}`,
    {
      parse_mode:   'Markdown',
      reply_markup: salahButtons(waqt),
    },
  )
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
      return
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
    const record = normalizeSalahRecord(raw)
    if (!shouldEscalateSalah(record)) continue

    const { windowEnd, waqt, remindersSent } = record
    let { windowStart } = record

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

    const progress = windowProgress(windowStart, windowEnd)
    const msSinceStart = now - windowStart

    // Azan at window start (first ~6 min) — Tier 2 + voice + ntfy
    if (msSinceStart >= 0 && msSinceStart < 6 * 60 * 1000 && remindersSent === 0) {
      const name = waqtName(waqt)
      const msg = level1Message(waqt, name, today, remindersSent)
      await notify({
        tier:         escalationLevel >= 2 ? 2 : 1,
        title:        `${name} Azan`,
        message:      msg,
        category:     'salah',
        voice:        true,
        skipTelegram: true,
      })
      await sendTelegramSafe(
        bot,
        ownerChatId,
        `🕌 *${name}-এর আযান হয়েছে*\n\n${msg}`,
        { parse_mode: 'Markdown', reply_markup: salahButtons(waqt) },
      )

      // Same-day carryover: previous waqt still pending
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

    // Window closed → mark missed (only after windowEnd, never if owner already confirmed)
    if (now > windowEnd) {
      if (record.confirmedAt) continue
      await upsertSalahRecord({ date: today, waqt, status: 'missed' })

      const name = waqtName(waqt)
      const missedMsg = `❌ ${name}-এর ওয়াক্ত শেষ\n\n${missedMessage(waqt, name, today, griefContext)}`
      await notify({
        tier:         2,
        title:        `${name} window ended`,
        message:      missedMsg,
        category:     'salah',
        voice:        false,
        skipTelegram: true,
      })
      await sendTelegramSafe(bot, ownerChatId, missedMsg, {
        parse_mode: 'Markdown',
        reply_markup: qazaButtons(waqt),
      })
      continue
    }

    // At ~40%: Level 1 gentle reminder + ntfy push
    if (progress >= 40 && remindersSent === 1) {
      const name = waqtName(waqt)
      const msg = level1Message(waqt, name, today, remindersSent)
      await notify({
        tier:         1,
        title:        `${name} reminder`,
        message:      msg,
        category:     'salah',
        skipTelegram: true,
      })
      await sendTelegramSafe(bot, ownerChatId, msg, {
        parse_mode: 'Markdown',
        reply_markup: salahButtons(waqt),
      })
      await upsertSalahRecord({ date: today, waqt, incrementReminders: true })
    }

    // At ~70%: Level 2 firm reminder + voice
    if (progress >= 70 && remindersSent <= 2) {
      const name = waqtName(waqt)
      const msg = level2Message(waqt, name, today, remindersSent)
      await notify({
        tier:         escalationLevel >= 2 ? 2 : 1,
        title:        `${name} ending soon`,
        message:      msg,
        category:     'salah',
        voice:        true,
        skipTelegram: true,
      })
      await sendTelegramSafe(bot, ownerChatId, msg, {
        parse_mode: 'Markdown',
        reply_markup: salahButtons(waqt),
      })
      await upsertSalahRecord({ date: today, waqt, incrementReminders: true })
    }

    // At ~90%: Level 3 critical + call
    if (progress >= 90 && remindersSent <= 3) {
      const name = waqtName(waqt)
      const msg = level3Message(waqt, name, today, remindersSent, griefContext)
      await notify({
        tier:         Math.min(3, escalationLevel + 1),
        title:        `${name} last chance`,
        message:      msg,
        category:     'salah',
        voice:        true,
        skipTelegram: true,
      })
      await sendTelegramSafe(bot, ownerChatId, msg, {
        parse_mode: 'Markdown',
        reply_markup: salahButtons(waqt),
      })
      await upsertSalahRecord({ date: today, waqt, incrementReminders: true })
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
