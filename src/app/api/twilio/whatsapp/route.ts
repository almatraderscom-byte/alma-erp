/**
 * Twilio WhatsApp inbound webhook.
 *
 * Twilio POSTs an incoming WhatsApp message here (form-urlencoded). We validate
 * Twilio's signature, then hand the message to the SAME ingest the Meta Cloud-API
 * path uses (ingestWaInboundMessage → shared CS brain), so replies/AI behave
 * identically regardless of which WhatsApp provider delivered the message.
 *
 * Configure this URL in the Twilio console:
 *   Messaging → your WhatsApp sender → "When a message comes in" =
 *   https://alma-erp-six.vercel.app/api/twilio/whatsapp  (POST)
 */
import { type NextRequest } from 'next/server'
import { validateTwilioSignature } from '@/agent/lib/wa/twilio-wa'
import { ingestWaInboundMessage } from '@/agent/lib/wa/wa-ingest'

export const runtime = 'nodejs'

const onlyDigits = (s: string) => s.replace(/^whatsapp:/i, '').replace(/\D/g, '')

export async function POST(req: NextRequest) {
  const raw = await req.text()
  const params = Object.fromEntries(new URLSearchParams(raw)) as Record<string, string>

  // Twilio signs the EXACT public URL it was configured to call. Rebuild it from
  // the forwarded headers (Vercel sets x-forwarded-*); no query string on this route.
  const proto = req.headers.get('x-forwarded-proto') ?? 'https'
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? ''
  const url = `${proto}://${host}${new URL(req.url).pathname}`

  if (!validateTwilioSignature(url, params, req.headers.get('x-twilio-signature'))) {
    return new Response('invalid signature', { status: 403 })
  }

  const from = onlyDigits(params.From ?? '') // customer's WhatsApp number
  const to = onlyDigits(params.To ?? '') // our Twilio WhatsApp number = the "page"
  const messageId = params.MessageSid ?? params.SmsMessageSid ?? ''
  const body = params.Body ?? ''
  const name = params.ProfileName || undefined

  if (from && messageId) {
    try {
      await ingestWaInboundMessage({
        phoneNumberId: to,
        waId: from,
        messageId,
        text: body || undefined,
        customerName: name,
      })
    } catch (err) {
      console.warn('[twilio-wa] inbound ingest failed:', err instanceof Error ? err.message : err)
    }
  }

  // Empty TwiML → 200, no synchronous auto-reply (the CS brain replies async).
  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  })
}

/** Health check / quick reachability test in a browser. */
export async function GET() {
  return new Response('Twilio WhatsApp webhook OK', { status: 200 })
}
