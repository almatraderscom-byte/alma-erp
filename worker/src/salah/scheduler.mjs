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

// ── Tone ladder messages ──────────────────────────────────────────────────────

function level1Message(waqt) {
  const name = WAQT_NAMES[waqt] || waqt
  return `🕌 ${name}-এর সময় হয়েছে, Sir।\n\nরাসূলুল্লাহ ﷺ বলেছেন: "নামাযের সময় হলে তোমাদের একজন আযান দিক।" (বুখারি)\nনামাজ আল্লাহর সাথে কথোপকথনের সেরা সুযোগ।`
}

function level2Message(waqt) {
  const name = WAQT_NAMES[waqt] || waqt
  return `⚠️ Sir, ${name}-এর সময় শেষ হতে চলেছে।\n\nআল্লাহ বলেছেন: "নিশ্চয়ই নামাজ মুমিনদের উপর নির্ধারিত সময়ে ফরজ।" (সূরা নিসা: ১০৩)\nকিয়ামতে সর্বপ্রথম নামাজের হিসাব নেওয়া হবে — নামাজ ঠিক থাকলে বাকি সব ঠিক, নামাজ নষ্ট হলে বাকি সবই নষ্ট। (তিরমিযি)\nএখনই পড়ুন, Sir।`
}

function level3Message(waqt, griefContext) {
  const name = WAQT_NAMES[waqt] || waqt
  let msg =
    `🚨 Sir! ${name}-এর ওয়াক্ত প্রায় শেষ।\n\n` +
    `আল্লাহ বলেছেন: "প্রতিটি আত্মাকে মৃত্যুর স্বাদ নিতে হবে।" (সূরা আল-ইমরান: ১৮৫)\n\n` +
    `আপনি কি নিশ্চিত যে আগামীকালটা আপনার থাকবে?`

  if (griefContext?.trim()) {
    msg += `\n\n${griefContext}\n\nতার কথা মনে রাখুন — তিনিও কি জানতেন শেষ নামাজটা শেষ নামাজ হয়ে যাবে?`
  }

  msg +=
    `\n\nএখনো দেরি হয়নি। আল্লাহ তওবা কবুল করেন। এক্ষুনি পড়ুন — কাযা হলেও পড়ুন।`

  return msg
}

function missedMessage(waqt, griefContext) {
  const name = WAQT_NAMES[waqt] || waqt
  let msg =
    `ইন্নালিল্লাহ! Sir, ${name}-এর ওয়াক্ত চলে গেছে।\n\n` +
    `রাসূলুল্লাহ ﷺ বলেছেন: "যে ব্যক্তি নামাজ ছেড়ে দিল সে যেন পরিবার ও সম্পদ হারাল।" (আহমাদ)`

  if (griefContext?.trim()) {
    msg += `\n\n${griefContext}`
  }

  msg +=
    `\n\nকাযা নামাজ এখনই পড়ুন, Sir। আল্লাহ অত্যন্ত ক্ষমাশীল ও দয়ালু।\n\nপড়েছেন কি?`

  return msg
}

// ── Inline keyboard buttons ───────────────────────────────────────────────────

function salahButtons(waqt) {
  return {
    inline_keyboard: [[
      { text: '✅ পড়েছি',    callback_data: `salah_done:${waqt}:prayed_on_time` },
      { text: '🕐 পরে পড়বো', callback_data: `salah_later:${waqt}` },
    ]],
  }
}

function qazaButtons(waqt) {
  return {
    inline_keyboard: [[
      { text: '✅ কাযা পড়েছি', callback_data: `salah_done:${waqt}:qaza` },
      { text: '😔 মিস হয়েছে',  callback_data: `salah_done:${waqt}:missed` },
    ]],
  }
}

// ── Send azan notification ────────────────────────────────────────────────────

async function sendAzanNotification(bot, ownerChatId, waqt, prevPendingWaqt, settings) {
  const name = WAQT_NAMES[waqt] || waqt
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
  const text = level1Message(waqt)

  await notify({
    tier,
    title:    `🕌 ${name}-এর আযান`,
    message:  text,
    category: 'salah',
    voice:    true,
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

// ── Escalation check (called on a schedule — e.g. every 5 min) ────────────────

export async function checkAndEscalateSalah({ supabase, bot }) {
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!ownerChatId) return

  const settings = await getSettings(['salah_escalation_level', 'salah_grief_reminder_enabled', 'salah_grief_context'])
  const escalationLevel = parseInt(settings.salah_escalation_level ?? '2', 10)
  const griefEnabled    = settings.salah_grief_reminder_enabled === 'true'
  const griefContext    = griefEnabled ? (settings.salah_grief_context ?? '') : ''

  const today   = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
  const records = await getSalahRecords(today)
  const now     = new Date()

  for (const record of records) {
    if (record.status !== 'pending') continue

    const windowStart = new Date(record.window_start)
    const windowEnd   = new Date(record.window_end)

    // Only process if window has started
    if (now < windowStart) continue

    const progress = windowProgress(windowStart, windowEnd)

    // Window closed → mark missed
    if (progress >= 100) {
      await upsertSalahRecord({
        date: today, waqt: record.waqt, status: 'missed',
      })

      const missedMsg = missedMessage(record.waqt, griefContext)
      await notify({
        tier:     2,
        title:    `❌ ${WAQT_NAMES[record.waqt]}-এর ওয়াক্ত শেষ`,
        message:  missedMsg,
        category: 'salah',
      })
      await bot.telegram.sendMessage(
        ownerChatId,
        missedMsg,
        { reply_markup: qazaButtons(record.waqt) },
      )
      continue
    }

    // Skip if reminders already maxed for this window
    const remindersSent = record.reminders_sent ?? 0

    // At ~40%: Level 1 gentle reminder
    if (progress >= 40 && remindersSent === 0) {
      const msg = level1Message(record.waqt)
      await bot.telegram.sendMessage(
        ownerChatId,
        `⏰ ${msg}`,
        { reply_markup: salahButtons(record.waqt) },
      )
      await upsertSalahRecord({ date: today, waqt: record.waqt, incrementReminders: true })
    }

    // At ~70%: Level 2 firm reminder + voice
    if (progress >= 70 && remindersSent <= 1) {
      const msg = level2Message(record.waqt)
      await notify({
        tier:     escalationLevel >= 2 ? 2 : 1,
        title:    `⚠️ ${WAQT_NAMES[record.waqt]} — সময় শেষ হচ্ছে`,
        message:  msg,
        category: 'salah',
        voice:    true,
      })
      await bot.telegram.sendMessage(
        ownerChatId,
        msg,
        { reply_markup: salahButtons(record.waqt) },
      )
      await upsertSalahRecord({ date: today, waqt: record.waqt, incrementReminders: true })
    }

    // At ~90%: Level 3 critical
    if (progress >= 90 && remindersSent <= 2) {
      const msg = level3Message(record.waqt, griefContext)
      await notify({
        tier:     Math.min(3, escalationLevel + 1),
        title:    `🚨 ${WAQT_NAMES[record.waqt]} — শেষ সুযোগ`,
        message:  msg,
        category: 'salah',
        voice:    true,
      })
      await bot.telegram.sendMessage(
        ownerChatId,
        msg,
        { reply_markup: salahButtons(record.waqt) },
      )
      await upsertSalahRecord({ date: today, waqt: record.waqt, incrementReminders: true })
    }
  }
}

// ── Initialize today's salah records at dawn ──────────────────────────────────

export async function initializeDailySalahRecords(supabase) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
  const times = await getPrayerTimes(new Date())

  for (const waqt of WAQT_ORDER) {
    const window = times[waqt]
    if (!window) continue

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

    const windowStart = ov?.override_time
      ? new Date(ov.override_time)
      : ov?.delay_until
        ? new Date(ov.delay_until)
        : window.start

    await upsertSalahRecord({
      date:        today,
      waqt,
      windowStart: windowStart.toISOString(),
      windowEnd:   window.end.toISOString(),
      status:      'pending',
    })
  }

  console.log(`[salah] initialized ${WAQT_ORDER.length} salah records for ${today}`)
}

// ── Handle Telegram salah button callbacks ────────────────────────────────────

export async function handleSalahCallback(ctx, action, waqt, status) {
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!ownerChatId || String(ctx.chat?.id) !== ownerChatId) return

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })

  if (action === 'salah_done') {
    await upsertSalahRecord({ date: today, waqt, status })
    const messages = {
      prayed_on_time: `✅ আলহামদুলিল্লাহ, ${WAQT_NAMES[waqt]} পড়েছেন। আল্লাহ কবুল করুন।`,
      prayed_late:    `✅ আলহামদুলিল্লাহ। পরের ওয়াক্ত সময়মতো পড়ার চেষ্টা করুন।`,
      qaza:           `✅ কাযা পড়া হয়েছে — আল্লাহ কবুল করুন।`,
      missed:         `😔 আল্লাহ মাফ করুন। পরের ওয়াক্ত মিস করবেন না।`,
    }
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {})
    await ctx.answerCbQuery(messages[status] || 'আপডেট হয়েছে')
    await ctx.reply(messages[status] || 'রেকর্ড আপডেট হয়েছে।')
  } else if (action === 'salah_later') {
    await ctx.answerCbQuery('ঠিক আছে — মনে করিয়ে দেব।')
    await ctx.reply(`ঠিক আছে Sir। সময়মতো পড়বেন — ${WAQT_NAMES[waqt]}-এর সময় শেষ হওয়ার আগেই পড়ুন।`)
  }
}

export { WAQT_NAMES, level1Message, level2Message, level3Message }
