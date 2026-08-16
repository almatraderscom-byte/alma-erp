/**
 * How many chats have something Boss has not seen. Deliberately tiny: the phone
 * polls this for the badge on the chat-history button, so it must not drag the
 * whole conversation list along with it.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { countUnreadConversations } from '@/agent/lib/conversation-unread'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  try {
    return Response.json({ count: await countUnreadConversations() })
  } catch (err) {
    // A badge is not worth a 500 on the chat screen.
    console.warn('[conversations/unread] count failed:', err instanceof Error ? err.message : err)
    return Response.json({ count: 0 })
  }
}
