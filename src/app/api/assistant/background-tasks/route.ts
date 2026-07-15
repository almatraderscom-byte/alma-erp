import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { listActiveBackgroundTurns } from '@/agent/lib/background-tasks/active-turns'

export const runtime = 'nodejs'

/** One owner-global active-turn feed shared by every native Agent chat session. */
export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const turns = await listActiveBackgroundTurns()
  return Response.json({ turns, count: turns.length })
}
