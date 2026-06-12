/**
 * Meta Messenger webhook — CS-1 customer inbound (real-time).
 * GET: hub.challenge verification
 * POST: signed inbound messages → cs_messages + cs_reply_jobs
 */
import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { verifyMetaWebhookSignature, pageAccessToken } from '@/agent/lib/cs/meta-messenger'
import { findOrCreateCsConversation, appendCsMessage } from '@/agent/lib/cs/conversations'
import { csReplyPermitted } from '@/agent/lib/cs/modes'
import { downloadMessengerAttachment } from '@/agent/lib/cs/meta-messenger'
import { agentStorageUpload } from '@/agent/lib/storage'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get('hub.mode')
  const token = req.nextUrl.searchParams.get('hub.verify_token')
  const challenge = req.nextUrl.searchParams.get('hub.challenge')
  const expected = process.env.META_WEBHOOK_VERIFY_TOKEN ?? ''

  if (mode === 'subscribe' && token === expected && challenge) {
    return new Response(challenge, { status: 200 })
  }
  return Response.json({ error: 'forbidden' }, { status: 403 })
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const rawBody = await req.text()
  const sig = req.headers.get('x-hub-signature-256')
  if (!verifyMetaWebhookSignature(rawBody, sig)) {
    return Response.json({ error: 'invalid_signature' }, { status: 401 })
  }

  let body: {
    object?: string
    entry?: Array<{
      id?: string
      messaging?: Array<{
        sender?: { id?: string }
        recipient?: { id?: string }
        message?: {
          mid?: string
          text?: string
          attachments?: Array<{ type?: string; payload?: { url?: string } }>
        }
      }>
    }>
  }

  try { body = JSON.parse(rawBody) } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  if (body.object !== 'page') return Response.json({ ok: true })

  for (const entry of body.entry ?? []) {
    const pageId = String(entry.id ?? '')
    if (!pageAccessToken(pageId)) continue

    for (const ev of entry.messaging ?? []) {
      const psid = ev.sender?.id
      const msg = ev.message
      if (!psid || !msg?.mid) continue

      const conv = await findOrCreateCsConversation({ pageId, psid })
      const content: unknown[] = []
      let imageRef: string | undefined

      if (msg.text) content.push({ type: 'text', text: msg.text })

      for (const att of msg.attachments ?? []) {
        if (att.type === 'image' && att.payload?.url) {
          try {
            const { buffer, mimeType } = await downloadMessengerAttachment(att.payload.url)
            const path = `cs-inbound/${conv.id}/${msg.mid}.jpg`
            await agentStorageUpload(path, buffer, mimeType)
            imageRef = path
            content.push({ type: 'image_ref', path, mimeType })
          } catch (err) {
            console.error('[messenger-webhook] image save failed:', err)
            content.push({ type: 'image_url', url: att.payload.url })
          }
        }
      }

      const stored = await appendCsMessage(conv.id, 'user', content, msg.mid)

      const { permitted } = await csReplyPermitted(conv)
      if (!permitted) continue

      await db.csReplyJob.upsert({
        where: { messageId: stored.id },
        create: {
          conversationId: conv.id,
          messageId: stored.id,
          status: 'pending',
        },
        update: { status: 'pending', attempts: 0, lastError: null },
      })
    }
  }

  return Response.json({ ok: true })
}
