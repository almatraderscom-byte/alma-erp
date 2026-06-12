/**
 * Push an approval card to the owner's Telegram (Vercel / internal routes).
 * Plain text only — avoids Markdown parse errors on phone numbers and quotes.
 */

export async function sendOwnerApprovalCard(input: {
  summary: string
  pendingActionId: string
  approveLabel?: string
  rejectLabel?: string
}): Promise<{ ok: boolean; error?: string }> {
  const token = process.env.ASSISTANT_BOT_TOKEN
  const chatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!token || !chatId) {
    return { ok: false, error: 'ASSISTANT_BOT_TOKEN or TELEGRAM_OWNER_CHAT_ID not set' }
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: `📋 অনুমোদন প্রয়োজন\n\n${input.summary}`,
      reply_markup: {
        inline_keyboard: [[
          { text: input.approveLabel ?? '✅ আবার কল দিন', callback_data: `approve:${input.pendingActionId}` },
          { text: input.rejectLabel ?? '❌ না', callback_data: `reject:${input.pendingActionId}` },
        ]],
      },
    }),
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

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  })

  const data = await res.json() as { ok?: boolean; description?: string }
  if (!res.ok || !data.ok) {
    return { ok: false, error: data.description ?? `HTTP ${res.status}` }
  }
  return { ok: true }
}
