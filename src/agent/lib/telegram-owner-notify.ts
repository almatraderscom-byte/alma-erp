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

  // Mirror to WhatsApp as a tap-button approval (best-effort, dormant until configured).
  if (input.pendingActionId) {
    try {
      const { sendOwnerWaApproval } = await import('./wa/wa-approval')
      await sendOwnerWaApproval(input.summary, input.pendingActionId)
    } catch { /* never break the Telegram path */ }
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
  // Mirror the decision buttons to the owner's WhatsApp (best-effort, dormant).
  if (reply_markup?.inline_keyboard?.length) {
    try {
      const { mirrorOwnerKeyboardToWhatsApp } = await import('./wa/wa-approval')
      await mirrorOwnerKeyboardToWhatsApp(caption ?? '📋 অনুমোদন প্রয়োজন', reply_markup.inline_keyboard, photo)
    } catch { /* never break Telegram */ }
  }
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
  // Telegram below ALWAYS fires regardless, so a closed 24h WhatsApp window never drops a
  // notification — it just isn't duplicated to WhatsApp until the owner messages again.
  const wa = await mirrorOwnerNotifyToWhatsApp(text)
  if (process.env.OWNER_WHATSAPP_NUMBER && !wa.sent && wa.reason === 'twilio_error') {
    console.warn('[owner-notify] WhatsApp copy not delivered (24h window likely closed) — Telegram still sent:', wa.error)
  }

  const token = process.env.ASSISTANT_BOT_TOKEN
  const chatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!token || !chatId) {
    return { ok: false, error: 'ASSISTANT_BOT_TOKEN or TELEGRAM_OWNER_CHAT_ID not set' }
  }

  // Telegram hard-limits one message to 4096 chars — a longer text is rejected outright
  // (owner saw call summaries arrive half-cut). Split into ≤~3900-char parts on line
  // boundaries and send them in order so nothing is dropped.
  const parts = splitForTelegram(text)
  let lastErr: string | undefined
  for (const part of parts) {
    const res = await fetch(`${telegramApiBase()}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: part }),
      signal: AbortSignal.timeout(8_000),
    })
    const data = await res.json() as { ok?: boolean; description?: string }
    if (!res.ok || !data.ok) lastErr = data.description ?? `HTTP ${res.status}`
  }
  return lastErr ? { ok: false, error: lastErr } : { ok: true }
}

/** Split text into Telegram-safe (<4096) chunks, preferring line breaks near the limit. */
export function splitForTelegram(text: string, limit = 3900): string[] {
  if (text.length <= limit) return [text]
  const parts: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < limit * 0.5) cut = limit // no good newline — hard-cut
    parts.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n/, '')
  }
  if (rest) parts.push(rest)
  return parts
}

/**
 * Owner Telegram message WITH inline approve/reject buttons + WhatsApp mirror (buttons).
 * Use for any owner-facing text that references pending items so the owner can TAP to act
 * instead of typing (which forces a fragile LLM re-parse). callback_data must use the
 * bot's existing `approve:<id>` / `reject:<id>` contract.
 */
export async function sendOwnerActionable(
  text: string,
  inlineKeyboard: Array<Array<{ text: string; callback_data: string }>>,
): Promise<{ ok: boolean; error?: string }> {
  // WhatsApp mirror with the same buttons (best-effort, dormant until configured).
  if (inlineKeyboard?.length) {
    try {
      const { mirrorOwnerKeyboardToWhatsApp } = await import('./wa/wa-approval')
      await mirrorOwnerKeyboardToWhatsApp(text, inlineKeyboard)
    } catch { /* never break Telegram */ }
  }

  const token = process.env.ASSISTANT_BOT_TOKEN
  const chatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!token || !chatId) return { ok: false, error: 'ASSISTANT_BOT_TOKEN or TELEGRAM_OWNER_CHAT_ID not set' }

  const res = await fetch(`${telegramApiBase()}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: inlineKeyboard?.length ? { inline_keyboard: inlineKeyboard } : undefined,
    }),
    signal: AbortSignal.timeout(8_000),
  })

  const data = await res.json() as { ok?: boolean; description?: string }
  if (!res.ok || !data.ok) return { ok: false, error: data.description ?? `HTTP ${res.status}` }
  return { ok: true }
}
