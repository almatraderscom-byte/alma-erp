/**
 * Push an approval card / status text to the owner's Telegram (Vercel / internal routes).
 * Plain text only — avoids Markdown parse errors on phone numbers and quotes.
 *
 * Honors `TELEGRAM_API_BASE` env var so calls can be routed through the same
 * Cloudflare proxy used by the VPS worker. Falls back to api.telegram.org direct.
 */

function telegramApiBase(): string {
  const override = (process.env.TELEGRAM_API_BASE ?? '').replace(/\/$/, '')
  return override || 'https://api.telegram.org'
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

/** Plain status text to owner Telegram (no buttons). */
export async function sendOwnerText(text: string): Promise<{ ok: boolean; error?: string }> {
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
