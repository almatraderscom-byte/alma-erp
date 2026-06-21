import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { requestTurnCancel } from '@/agent/lib/turn-status'

export const runtime = 'nodejs'

/**
 * Owner Stop button — real server-side cancel. The running turn lives in a
 * different serverless instance than this request, so we can't reach its
 * AbortController; instead we flip a DB flag the turn polls each iteration.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const { id } = await Promise.resolve(params)
  if (!id) return Response.json({ error: 'turn_id_required' }, { status: 400 })

  const ok = await requestTurnCancel(id)
  if (!ok) return Response.json({ error: 'turn_not_found' }, { status: 404 })
  return Response.json({ ok: true })
}
