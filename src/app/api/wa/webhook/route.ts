/**
 * WhatsApp Cloud API webhook — inbound messages + verify token.
 * GET: Meta hub.challenge verification (WA_VERIFY_TOKEN)
 * POST: inbound messages → shared CS brain (shadow mode by default)
 */
import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { verifyWaSubscribeToken, waConfigured } from '@/agent/lib/wa/cloud-api'
import { ingestWaInboundMessage, markWaHandledInApp } from '@/agent/lib/wa/wa-ingest'
import { waPageId } from '@/agent/lib/wa/constants'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get('hub.mode')
  const token = req.nextUrl.searchParams.get('hub.verify_token')
  const challenge = req.nextUrl.searchParams.get('hub.challenge')

  if (mode === 'subscribe' && verifyWaSubscribeToken(token) && challenge) {
    return new Response(challenge, { status: 200 })
  }
  return Response.json({ error: 'forbidden' }, { status: 403 })
}

type WaWebhookBody = {
  object?: string
  entry?: Array<{
    id?: string
    changes?: Array<{
      field?: string
      value?: {
        messaging_product?: string
        metadata?: { phone_number_id?: string; display_phone_number?: string }
        contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>
        messages?: Array<{
          from?: string
          id?: string
          timestamp?: string
          type?: string
          text?: { body?: string }
        }>
        statuses?: Array<{
          id?: string
          status?: string
          recipient_id?: string
        }>
        smb_message_echoes?: Array<{
          from?: string
          to?: string
          id?: string
          type?: string
          text?: { body?: string }
        }>
      }
    }>
  }>
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  if (!waConfigured()) {
    return Response.json({ ok: true, skipped: 'wa_not_configured' })
  }

  let body: WaWebhookBody
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  if (body.object !== 'whatsapp_business_account') {
    return Response.json({ ok: true })
  }

  const ourPhoneId = process.env.WA_PHONE_ID ?? ''

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {}
      const phoneNumberId = String(value.metadata?.phone_number_id ?? ourPhoneId)
      const pageId = waPageId(phoneNumberId)

      // Coexistence: messages sent from WhatsApp Business App — mark handled, no auto-reply.
      for (const echo of value.smb_message_echoes ?? []) {
        const to = echo.to ?? ''
        if (to) void markWaHandledInApp(pageId, to).catch(() => {})
        console.log(`[wa-webhook] smb_echo to=${to} — coexistence, skip auto-reply`)
      }

      const contactName = value.contacts?.[0]?.profile?.name

      for (const msg of value.messages ?? []) {
        if (msg.type !== 'text' || !msg.text?.body) continue
        if (msg.from === value.metadata?.display_phone_number?.replace(/\D/g, '')) {
          continue
        }

        const result = await ingestWaInboundMessage({
          phoneNumberId,
          waId: String(msg.from ?? ''),
          messageId: String(msg.id ?? ''),
          text: msg.text.body,
          customerName: contactName,
          timestamp: msg.timestamp,
        })

        console.log(`[wa-webhook] ingest ${result.ingested ? 'ok' : result.reason} wa=${msg.from}`)
      }
    }
  }

  return Response.json({ ok: true })
}
