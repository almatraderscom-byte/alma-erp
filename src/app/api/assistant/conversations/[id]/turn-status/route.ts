import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { getLatestTurn } from '@/agent/lib/turn-status'

export const runtime = 'nodejs'

/**
 * Latest turn status for a conversation. The client polls this on app re-open: a
 * turn keeps running server-side after backgrounding, so the app waits for the
 * status to leave `running`, then re-fetches messages to render the reply.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const { id } = await Promise.resolve(params)
  const turn = await getLatestTurn(id)
  if (!turn) return Response.json({ status: 'idle', turnId: null })
  return Response.json({ status: turn.status, turnId: turn.id, startedAt: turn.startedAt })
}
