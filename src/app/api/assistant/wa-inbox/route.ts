/**
 * GET /api/assistant/wa-inbox — owner-only live WhatsApp inbox feed.
 *
 * Powers the WhatsApp-style screen at /agent/whatsapp. Twilio WhatsApp inbound is
 * stored in our own CsConversation/CsMessage tables (page_id prefixed "wa:"), so this
 * reads straight from the DB and returns each thread with its recent message history,
 * shaped for a chat UI. Polled by the client for a live feel.
 *
 * Owner-session-gated (SUPER_ADMIN). Read-only.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/** Pull readable text out of a CsMessage.content JSON ([{type:'text',text}] or string). */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    const parts = content
      .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text?: unknown }).text ?? '') : ''))
      .filter(Boolean)
    if (parts.length) return parts.join(' ').trim()
    const types = content
      .map((b) => (b && typeof b === 'object' && 'type' in b ? String((b as { type?: unknown }).type ?? '') : ''))
      .filter(Boolean)
    if (types.length) return `(${types[0]})`
  }
  return ''
}

type WaConvRow = {
  psid: string
  customerName: string | null
  lastMessageAt: Date | null
  lastCustomerMessageAt: Date | null
  lastCsReplyAt: Date | null
  messages: Array<{ role: string; content: unknown; createdAt: Date }>
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  try {
    const convs: WaConvRow[] = await db.csConversation.findMany({
      where: { pageId: { startsWith: 'wa:' } },
      orderBy: { lastMessageAt: 'desc' },
      take: 50,
      select: {
        psid: true,
        customerName: true,
        lastMessageAt: true,
        lastCustomerMessageAt: true,
        lastCsReplyAt: true,
        messages: { orderBy: { createdAt: 'asc' }, take: 60, select: { role: true, content: true, createdAt: true } },
      },
    })

    const threads = convs.map((c) => {
      const msgs = (c.messages ?? []).map((m) => ({
        from: m.role === 'user' ? 'them' : 'us',
        text: messageText(m.content) || '(মিডিয়া)',
        at: m.createdAt,
      }))
      const last = msgs[msgs.length - 1]
      const needsReply = Boolean(
        c.lastCustomerMessageAt && (!c.lastCsReplyAt || c.lastCustomerMessageAt > c.lastCsReplyAt),
      )
      return {
        id: c.psid,
        number: c.psid,
        name: c.customerName || c.psid,
        lastMessage: last?.text ?? '',
        lastAt: c.lastMessageAt,
        needsReply,
        messages: msgs,
      }
    })

    const awaitingReply = threads.filter((t) => t.needsReply).length
    return Response.json({ ok: true, count: threads.length, awaitingReply, threads })
  } catch (err) {
    return Response.json({ ok: false, error: String(err), threads: [] }, { status: 200 })
  }
}
