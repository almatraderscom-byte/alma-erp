import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { assembleTurnTrace } from '@/agent/lib/turn-trace'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/assistant/turn/:id/trace — the assembled decision trace for one
 * turn (audit P0-1): admission span, every route/guard/tool/approval span with
 * guard reason codes, and the cost-governor spend lineage. Owner-only.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const trace = await assembleTurnTrace(params.id)
  if (!trace) return Response.json({ error: 'turn_not_found' }, { status: 404 })
  return Response.json(trace)
}
