/**
 * WhatsApp Cloud API helpers (send + webhook signature verify).
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
 */

const GRAPH = 'https://graph.facebook.com/v21.0'

export function waConfigured(): boolean {
  return Boolean(process.env.WA_PHONE_ID && process.env.WA_TOKEN)
}

export function waVerifyToken(): string {
  return process.env.WA_VERIFY_TOKEN ?? process.env.META_WEBHOOK_VERIFY_TOKEN ?? ''
}

export function waAppSecret(): string {
  return process.env.META_APP_SECRET ?? ''
}

/** Constant-time-ish compare for verify token (webhook GET). */
export function verifyWaSubscribeToken(provided: string | null): boolean {
  const expected = waVerifyToken()
  if (!expected || !provided) return false
  if (provided.length !== expected.length) return false
  let mismatch = 0
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ provided.charCodeAt(i)
  }
  return mismatch === 0
}

export async function sendWaText(input: {
  phoneNumberId: string
  to: string
  text: string
}): Promise<{ messageId?: string }> {
  const token = process.env.WA_TOKEN
  if (!token) throw new Error('WA_TOKEN not configured')

  const res = await fetch(`${GRAPH}/${input.phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: input.to.replace(/\D/g, ''),
      type: 'text',
      text: { preview_url: false, body: input.text.slice(0, 4096) },
    }),
    signal: AbortSignal.timeout(20_000),
  })

  const data = await res.json().catch(() => ({})) as {
    messages?: Array<{ id?: string }>
    error?: { message?: string }
  }
  if (!res.ok) throw new Error(data.error?.message ?? `WA send HTTP ${res.status}`)
  return { messageId: data.messages?.[0]?.id }
}

export async function sendWaTemplate(input: {
  phoneNumberId: string
  to: string
  templateName: string
  languageCode?: string
  components?: unknown[]
}): Promise<{ messageId?: string }> {
  const token = process.env.WA_TOKEN
  if (!token) throw new Error('WA_TOKEN not configured')

  const res = await fetch(`${GRAPH}/${input.phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: input.to.replace(/\D/g, ''),
      type: 'template',
      template: {
        name: input.templateName,
        language: { code: input.languageCode ?? 'en' },
        components: input.components ?? [],
      },
    }),
    signal: AbortSignal.timeout(20_000),
  })

  const data = await res.json().catch(() => ({})) as {
    messages?: Array<{ id?: string }>
    error?: { message?: string }
  }
  if (!res.ok) throw new Error(data.error?.message ?? `WA template HTTP ${res.status}`)
  return { messageId: data.messages?.[0]?.id }
}
