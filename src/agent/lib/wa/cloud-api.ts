/**
 * WhatsApp Cloud API helpers (send + webhook signature verify).
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
 */
import { createHmac, timingSafeEqual } from 'crypto'

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

/**
 * Verify the X-Hub-Signature-256 HMAC on an inbound WhatsApp webhook POST.
 * Fails closed: returns false if META_APP_SECRET is unset or the header is
 * missing/malformed. `rawBody` MUST be the exact bytes Meta sent (read before
 * JSON parsing) or the HMAC will not match.
 */
export function verifyWaSignature(rawBody: string, signatureHeader: string | null): boolean {
  const secret = waAppSecret()
  if (!secret || !signatureHeader?.startsWith('sha256=')) return false
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
  const provided = signatureHeader.slice(7)
  try {
    const a = Buffer.from(expected, 'hex')
    const b = Buffer.from(provided, 'hex')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
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
