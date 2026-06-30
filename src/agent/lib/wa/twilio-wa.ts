/**
 * Twilio WhatsApp Business API — send + inbound signature validation.
 *
 * The app's other WhatsApp code (wa/cloud-api.ts) talks to Meta's Cloud API
 * directly; THIS module is the Twilio path the owner chose. It reuses the same
 * Twilio account the voice stack already uses (TWILIO_ACCOUNT_SID / AUTH_TOKEN)
 * plus one new var, TWILIO_WHATSAPP_FROM — the Twilio WhatsApp sender, e.g.
 * "whatsapp:+8801..." (or a bare "+8801...").
 *
 * Fully DORMANT until those env vars are set: every send returns a clear error
 * and the webhook fails closed, so adding this file can't affect anything that is
 * currently live. Sending is additionally gated by the WHATSAPP_SEND_ENABLED kill
 * switch (see wa-tools.ts) so even configured creds don't send until the owner
 * flips it on.
 */
import { createHmac, timingSafeEqual } from 'crypto'

const TWILIO_API = 'https://api.twilio.com/2010-04-01'

/** True only when the Twilio WhatsApp sender + account creds are all present. */
export function twilioWaConfigured(): boolean {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_WHATSAPP_FROM,
  )
}

/** Twilio wants "whatsapp:+<digits>"; accept a bare number or an already-prefixed value. */
export function toWhatsAppAddress(phone: string): string {
  const raw = String(phone ?? '').trim()
  if (raw.toLowerCase().startsWith('whatsapp:')) return raw
  const cleaned = raw.replace(/[^\d+]/g, '')
  const e164 = cleaned.startsWith('+') ? cleaned : `+${cleaned}`
  return `whatsapp:${e164}`
}

async function twilioSendMessage(form: Record<string, string>): Promise<{ sid?: string; error?: string }> {
  const sid = process.env.TWILIO_ACCOUNT_SID ?? ''
  const token = process.env.TWILIO_AUTH_TOKEN ?? ''
  const auth = Buffer.from(`${sid}:${token}`).toString('base64')
  try {
    const res = await fetch(`${TWILIO_API}/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(20_000),
    })
    const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number }
    if (!res.ok) return { error: data.message ?? `Twilio HTTP ${res.status}` }
    return { sid: data.sid }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** Send a plain WhatsApp text message via Twilio. */
export async function sendTwilioWaText(input: { to: string; body: string }): Promise<{ sid?: string; error?: string }> {
  if (!twilioWaConfigured()) return { error: 'Twilio WhatsApp not configured (set TWILIO_WHATSAPP_FROM).' }
  if (!input.body.trim()) return { error: 'empty message body' }
  return twilioSendMessage({
    From: toWhatsAppAddress(process.env.TWILIO_WHATSAPP_FROM ?? ''),
    To: toWhatsAppAddress(input.to),
    Body: input.body.slice(0, 1600),
  })
}

/** Send a WhatsApp media message (image/audio/voice-note/doc) by public URL. */
export async function sendTwilioWaMedia(input: {
  to: string
  mediaUrl: string
  body?: string
}): Promise<{ sid?: string; error?: string }> {
  if (!twilioWaConfigured()) return { error: 'Twilio WhatsApp not configured (set TWILIO_WHATSAPP_FROM).' }
  if (!input.mediaUrl) return { error: 'mediaUrl required' }
  const form: Record<string, string> = {
    From: toWhatsAppAddress(process.env.TWILIO_WHATSAPP_FROM ?? ''),
    To: toWhatsAppAddress(input.to),
    MediaUrl: input.mediaUrl,
  }
  if (input.body?.trim()) form.Body = input.body.slice(0, 1600)
  return twilioSendMessage(form)
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Place a ONE-WAY WhatsApp voice call (Twilio Programmable Voice over WhatsApp) that
 * speaks `message` then hangs up — the agent does NOT listen. Used for reminders.
 *
 * PREREQUISITES (WhatsApp rules — the call will fail at Twilio until both are met):
 *  1. WhatsApp Business Calling must be ENABLED on the sender (voice-activated).
 *  2. The recipient must have GRANTED call permission (anti-spam) — businesses can't
 *     cold-call a WhatsApp user.
 * Dormant + double-gated: configured creds AND WHATSAPP_CALL_ENABLED=true.
 *
 * NOTE: v1 uses TwiML <Say> (limited Bangla pronunciation). Bangla audio via
 * <Play> + Google TTS is a follow-up once live calling is verified working.
 */
export async function placeTwilioWaCall(input: { to: string; message: string }): Promise<{ sid?: string; error?: string }> {
  if (!twilioWaConfigured()) return { error: 'Twilio WhatsApp not configured (set TWILIO_WHATSAPP_FROM).' }
  if (process.env.WHATSAPP_CALL_ENABLED !== 'true') {
    return { error: 'WhatsApp calling is off (kill switch). Enable WhatsApp Business Calling on the sender, then set WHATSAPP_CALL_ENABLED=true.' }
  }
  const sid = process.env.TWILIO_ACCOUNT_SID ?? ''
  const token = process.env.TWILIO_AUTH_TOKEN ?? ''
  const auth = Buffer.from(`${sid}:${token}`).toString('base64')
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeXml(input.message.slice(0, 600))}</Say></Response>`
  try {
    const res = await fetch(`${TWILIO_API}/Accounts/${sid}/Calls.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        To: toWhatsAppAddress(input.to),
        From: toWhatsAppAddress(process.env.TWILIO_WHATSAPP_FROM ?? ''),
        Twiml: twiml,
      }).toString(),
      signal: AbortSignal.timeout(20_000),
    })
    const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string }
    if (!res.ok) return { error: data.message ?? `Twilio call HTTP ${res.status}` }
    return { sid: data.sid }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Fetch a Twilio Call's current status by SID — used to diagnose why a WhatsApp call
 * that returned a SID still didn't ring (status 'failed' / 'no-answer' / 'completed'
 * etc.). Returns the telling fields verbatim from the Twilio Call resource.
 */
export async function getTwilioCallStatus(callSid: string): Promise<Record<string, unknown> | { error: string }> {
  if (!twilioWaConfigured()) return { error: 'Twilio WhatsApp not configured.' }
  if (!/^CA[0-9a-f]{32}$/i.test(callSid)) return { error: 'bad call sid' }
  const sid = process.env.TWILIO_ACCOUNT_SID ?? ''
  const token = process.env.TWILIO_AUTH_TOKEN ?? ''
  const auth = Buffer.from(`${sid}:${token}`).toString('base64')
  try {
    const res = await fetch(`${TWILIO_API}/Accounts/${sid}/Calls/${callSid}.json`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(15_000),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) return { error: (data.message as string) ?? `Twilio HTTP ${res.status}` }
    return {
      status: data.status,
      to: data.to,
      from: data.from,
      direction: data.direction,
      duration: data.duration,
      start_time: data.start_time,
      end_time: data.end_time,
      answered_by: data.answered_by,
      price: data.price,
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Validate Twilio's `X-Twilio-Signature` for an inbound webhook: base64 of
 * HMAC-SHA1(authToken, fullUrl + each POST param key+value sorted by key).
 * Fails closed when the token or header is missing.
 * Ref: twilio.com/docs/usage/security#validating-requests
 */
export function validateTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string | null,
): boolean {
  const token = process.env.TWILIO_AUTH_TOKEN ?? ''
  if (!token || !signature) return false
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url)
  const expected = createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64')
  try {
    const a = Buffer.from(expected)
    const b = Buffer.from(signature)
    return a.length === b.length && timingSafeEqual(a, b)
  } catch {
    return false
  }
}
