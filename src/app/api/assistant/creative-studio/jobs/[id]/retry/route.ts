// CS4: "আবার চালাও" — recreate a FAILED studio job with the same payload
// (worker-internal progress fields stripped). Artifacts of the old attempt stay.
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const row = await db.agentPendingAction.findUnique({ where: { id: params.id } })
  if (!row) return Response.json({ error: 'not_found' }, { status: 404 })
  const payload = { ...(row.payload as Record<string, unknown>) }
  if (payload.creativeStudio !== true) return Response.json({ error: 'not_studio' }, { status: 422 })
  if (row.status !== 'failed') return Response.json({ error: 'শুধু ব্যর্থ কাজই আবার চালানো যায়।' }, { status: 422 })

  for (const k of Object.keys(payload)) if (k.startsWith('_')) delete payload[k]

  const fresh = await db.agentPendingAction.create({
    data: {
      conversationId: row.conversationId,
      type: row.type,
      payload,
      summary: `🔁 ${row.summary}`,
      costEstimate: row.costEstimate ?? 0,
      status: 'approved',
    },
  })
  return Response.json({ ok: true, pendingActionId: fresh.id })
}
