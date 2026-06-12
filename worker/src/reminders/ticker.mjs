/**
 * Reminder ticker — every minute: fire due reminders + escalate unacked tier≥2.
 */

import { notify } from '../notify/index.mjs'

const APP_URL   = process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = process.env.AGENT_INTERNAL_TOKEN ?? ''

async function callInternal(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${INT_TOKEN}`,
    },
  }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch(`${APP_URL}${path}`, opts)
  const text = await res.text()
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) } }
  catch { return { ok: res.ok, status: res.status, data: { raw: text } } }
}

function reminderButtons(id) {
  return {
    inline_keyboard: [[
      { text: '✅ Done', callback_data: `reminder_done:${id}` },
      { text: '⏰ +৩০ মিনিট', callback_data: `reminder_snooze:${id}:30` },
      { text: '🗑️ বাতিল', callback_data: `reminder_cancel:${id}` },
    ]],
  }
}

async function markSent(id, tier) {
  await callInternal('/api/assistant/internal/reminder-update', 'POST', {
    id, incrementSend: true, sendTier: tier,
  })
}

async function sendReminder(bot, ownerChatId, reminder, tierOverride = null) {
  const tier = tierOverride ?? reminder.tier ?? 1
  const title = reminder.title
  const message = reminder.body || reminder.title

  await notify({
    tier: Math.min(3, tier),
    title,
    message,
    category: 'urgent',
    voice: reminder.voice !== false,
    skipTelegram: true,
  })

  if (bot?.telegram && ownerChatId) {
    await bot.telegram.sendMessage(
      ownerChatId,
      `⏰ *${title}*\n\n${message}`,
      { parse_mode: 'Markdown', reply_markup: reminderButtons(reminder.id) },
    )
  }

  await markSent(reminder.id, tier)
  console.log(`[reminder-ticker] sent ${reminder.id} tier=${tier}`)
}

export async function runReminderTicker({ bot }) {
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  const res = await callInternal('/api/assistant/internal/reminders-due')
  if (!res.ok) {
    console.warn('[reminder-ticker] reminders-due failed:', res.status, res.data)
    return
  }

  const { due = [], escalation = [] } = res.data

  for (const reminder of due) {
    try {
      await sendReminder(bot, ownerChatId, reminder)
    } catch (err) {
      console.error(`[reminder-ticker] due ${reminder.id}:`, err.message)
    }
  }

  for (const reminder of escalation) {
    if (reminder.sendCount >= 3) continue
    try {
      let tier = reminder.tier
      if (reminder.sendCount === 2) {
        tier = Math.min(3, tier + 1)
      }
      await sendReminder(bot, ownerChatId, reminder, tier)
    } catch (err) {
      console.error(`[reminder-ticker] escalate ${reminder.id}:`, err.message)
    }
  }
}

export async function processUrgentNotify(payload) {
  const { tier = 2, title, message, voice = true } = payload
  await notify({
    tier,
    title: String(title),
    message: String(message),
    category: 'urgent',
    voice: voice !== false,
  })
  console.log(`[urgent-notify] dispatched tier=${tier} title=${title}`)
}

/** Owner-approved call to an arbitrary phone number with a spoken message. */
export async function processOutboundCall(payload) {
  const phone = String(payload.phone ?? '')
  const message = String(payload.message ?? '').trim()
  if (!phone || !message) throw new Error('phone and message required')

  const { makeTwilioCall } = await import('../notify/twilio-call.mjs')
  const result = await makeTwilioCall(message, { toNumber: phone, force: true, skipAutoRetry: true })
  if (!result.ok) throw new Error(result.error ?? 'call failed')
  console.log(`[outbound-call] ${phone} callSid=${result.callSid}`)
  return result
}
