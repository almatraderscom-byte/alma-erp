/**
 * Boss opened this chat — stamp it read so it drops out of the unread badge.
 *
 * Next 16: `params` is a Promise; read it via routeParams(), never off ctx.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { routeParams } from '@/lib/core/safe-api'
import { isSystemOwner } from '@/lib/roles'
import { countUnreadConversations, markConversationRead } from '@/agent/lib/conversation-unread'

export const runtime = 'nodejs'

export async function POST(req: NextRequest, ctx: unknown) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const { id } = await routeParams<{ id: string }>(ctx)
  if (!id) return Response.json({ error: 'id দরকার' }, { status: 400 })

  try {
    const ok = await markConversationRead(id)
    if (!ok) return Response.json({ error: 'not_found' }, { status: 404 })
    // Hand back the fresh badge number so the caller never has to poll twice.
    return Response.json({ ok: true, count: await countUnreadConversations() })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'read mark হয়নি' }, { status: 500 })
  }
}
