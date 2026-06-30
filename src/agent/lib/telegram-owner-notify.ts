/**
 * Push an approval card / status text to the owner's Telegram (Vercel / internal routes).
 * Plain text only — avoids Markdown parse errors on phone numbers and quotes.
 *
 * Honors `TELEGRAM_API_BASE` env var so calls can be routed through the same
 * Cloudflare proxy used by the VPS worker. Falls back to api.telegram.org direct.
 */

import { sendTwilioWaText, twilioWaConfigured } from './wa/twilio-wa'

function telegramApiBase(): string {
  const override = (process.env.TELEGRAM_API_BASE ?? '').replace(/\/$/, '')
  return override || 'https://api.telegram.org'
}

/**
 * Mirror an owner notification to the owner's WhatsApp, so WhatsApp works as a second
 * notification/reminder channel alongside Telegram. Best-effort + DORMANT: does nothing
 * unless OWNER_WHATSAPP_NUMBER is set, Twilio WhatsApp is configured, and the
 * WHATSAPP_SEND_ENABLED kill switch is on. Never throws into the caller.
 * (Free-form only reaches the owner inside WhatsApp's 24h window — i.e. within 24h of
 *  the owner last messaging the business number.)
 */
export async function mirrorOwnerNotifyToWhatsApp(
  text: string,
): Promise<{ sent: boolean; reason?: string; sid?: string; error?: string }> {
  const to = process.env.OWNER_WHATSAPP_NUMBER
  // Gated ONLY on the owner explicitly setting their number (that IS the opt-in) +
  // Twilio creds. No extra kill switch here — it's the owner's own number.
  if (!to) return { sent: false, reason: 'OWNER_WHATSAPP_NUMBER not set' }
  if (!text.trim()) return { sent: false, reason: 'empty text' }
  if (!twilioWaConfigured()) return { sent: false, reason: 'Twilio WhatsApp not configured' }
  try {
    const res = await sendTwilioWaText({ to, body: text })
    if (res.error) return { sent: false, reason: 'twilio_error', error: res.error }
    return { sent: true, sid: res.sid }
  } catch (err) {
    // best-effort: a WhatsApp failure must never break the owner's Telegram notify
    return { sent: false, reason: 'exception', error: err instanceof Error ? err.message : String(err) }
  }
}

export async function sendOwnerApprovalCard(input: {
  summary: string
  pendingActionId?: string
  approveLabel?: string
  rejectLabel?: string
  reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }
}): Promise<{ ok: boolean; error?: string }> {
  const token = process.env.ASSISTANT_BOT_TOKEN
  const chatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!token || !chatId) {
    return { ok: false, error: 'ASSISTANT_BOT_TOKEN or TELEGRAM_OWNER_CHAT_ID not set' }
  }

  const reply_markup = input.reply_markup ?? (input.pendingActionId ? {
    inline_keyboard: [[
      { text: input.approveLabel ?? '✅ আবার কল দিন', callback_data: `approve:${input.pendingActionId}` },
      { text: input.rejectLabel ?? '❌ না', callback_data: `reject:${input.pendingActionId}` },
    ]],
  } : undefined)

  const res = await fetch(`${telegramApiBase()}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: `📋 অনুমোদন প্রয়োজন\n\n${input.summary}`,
      reply_markup,
    }),
    signal: AbortSignal.timeout(8_000),
  })

  const data = await res.json() as { ok?: boolean; description?: string }
  if (!res.ok || !data.ok) {
    return { ok: false, error: data.description ?? `HTTP ${res.status}` }
  }
  return { ok: true }
}

/**
 * Send a PHOTO to the owner's Telegram with an optional caption. `photo` may be a
 * public/temporary URL (e.g. an Imou snapshot signed URL) — Telegram fetches it
 * server-side. Used by the staff idle-detection alert so the owner sees the frame.
 */
export async function sendOwnerPhoto(
  photo: string,
  caption?: string,
  reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> },
): Promise<{ ok: boolean; error?: string }> {
  const chatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!chatId) return { ok: false, error: 'TELEGRAM_OWNER_CHAT_ID not set' }
  return sendTelegramPhoto(chatId, photo, caption, reply_markup)
}

/**
 * Send a PHOTO to ANY Telegram chat with the assistant bot (owner DM, a staff
 * member's DM, or the office staff group). Used by the idle-detection staff-nudge
 * flow to forward the camera frame + a gentle reminder to the staff group once the
 * owner taps Approve. `photo` may be a public/temporary URL — Telegram fetches it
 * server-side; if it has expired the caller should retry with a fresh frame.
 */
export async function sendTelegramPhoto(
  chatId: string,
  photo: string,
  caption?: string,
  reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> },
): Promise<{ ok: boolean; error?: string }> {
  const token = process.env.ASSISTANT_BOT_TOKEN
  if (!token || !chatId) {
    return { ok: false, error: 'ASSISTANT_BOT_TOKEN or chatId not set' }
  }

  const res = await fetch(`${telegramApiBase()}/bot${token}/sendPhoto`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, photo, caption: caption?.slice(0, 1024), reply_markup }),
    signal: AbortSignal.timeout(12_000),
  })

  const data = await res.json() as { ok?: boolean; description?: string }
  if (!res.ok || !data.ok) {
    return { ok: false, error: data.description ?? `HTTP ${res.status}` }
  }
  return { ok: true }
}

/** Plain text to ANY Telegram chat (assistant bot). Text-only fallback for nudges. */
export async function sendTelegramText(
  chatId: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  const token = process.env.ASSISTANT_BOT_TOKEN
  if (!token || !chatId) {
    return { ok: false, error: 'ASSISTANT_BOT_TOKEN or chatId not set' }
  }

  const res = await fetch(`${telegramApiBase()}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(8_000),
  })

  const data = await res.json() as { ok?: boolean; description?: string }
  if (!res.ok || !data.ok) {
    return { ok: false, error: data.description ?? `HTTP ${res.status}` }
  }
  return { ok: true }
}

/** Plain status text to owner Telegram (no buttons) + WhatsApp mirror. */
export async function sendOwnerText(text: string): Promise<{ ok: boolean; error?: string }> {
  // Second channel: mirror to the owner's WhatsApp (best-effort, dormant until configured).
  await mirrorOwnerNotifyToWhatsApp(text)

  const token = process.env.ASSISTANT_BOT_TOKEN
  const chatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!token || !chatId) {
    return { ok: false, error: 'ASSISTANT_BOT_TOKEN or TELEGRAM_OWNER_CHAT_ID not set' }
  }

  const res = await fetch(`${telegramApiBase()}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(8_000),
  })

  const data = await res.json() as { ok?: boolean; description?: string }
  if (!res.ok || !data.ok) {
    return { ok: false, error: data.description ?? `HTTP ${res.status}` }
  }
  return { ok: true }
}
