/**
 * WhatsApp Cloud API send helpers (worker-side).
 */
import { resilientFetch } from '../fetch-retry.mjs'

const GRAPH = 'https://graph.facebook.com/v21.0'

function phoneNumberId(pageId) {
  return String(pageId ?? '').replace(/^wa:/, '')
}

export async function sendWaText(pageId, waId, text) {
  const token = process.env.WA_TOKEN
  const pid = phoneNumberId(pageId)
  if (!token) throw new Error('WA_TOKEN not configured')
  if (!pid) throw new Error('missing WA phone number id')

  const res = await resilientFetch(`${GRAPH}/${pid}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: String(waId).replace(/\D/g, ''),
      type: 'text',
      text: { preview_url: false, body: String(text).slice(0, 4096) },
    }),
    timeoutMs: 20_000,
    retries: 1,
  })

  const data = await res.json()
  if (!res.ok) throw new Error(data.error?.message ?? `WA HTTP ${res.status}`)
  return data
}

export async function sendWaTyping(pageId, waId) {
  const token = process.env.WA_TOKEN
  const pid = phoneNumberId(pageId)
  if (!token || !pid) return
  await resilientFetch(`${GRAPH}/${pid}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: 'placeholder',
    }),
  }).catch(() => {})
}
