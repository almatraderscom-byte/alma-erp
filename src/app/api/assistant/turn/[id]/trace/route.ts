import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { assembleTurnTrace } from '@/agent/lib/turn-trace'
import { loadStageTrace } from '@/agent/lib/turn-stage-trace'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/assistant/turn/:id/trace — the assembled decision trace for one
 * turn (audit P0-1): admission span, every route/guard/tool/approval span with
 * guard reason codes, and the cost-governor spend lineage. Owner-only.
 */
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  // P0-2 rides along here rather than getting its own route: the decision trace
  // answers "what did it do", the stage split answers "where did the minute go",
  // and when an approval feels slow those are the same question.
  const [trace, stageTrace] = await Promise.all([
    assembleTurnTrace(params.id),
    loadStageTrace(params.id),
  ])
  if (!trace) return Response.json({ error: 'turn_not_found' }, { status: 404 })
  return Response.json({ ...trace, stageTrace })
}
