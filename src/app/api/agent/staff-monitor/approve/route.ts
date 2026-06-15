import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const body = await req.json() as { actionId?: string; decision?: 'approve' | 'reject' }
  if (!body.actionId || !body.decision) {
    return Response.json({ error: 'actionId and decision required' }, { status: 400 })
  }

  type PendingRow = { id: string; payload: Record<string, unknown> | null; status: string }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = await (prisma as any).agentPendingAction.findUnique({
    where: { id: body.actionId },
    select: { id: true, payload: true, status: true },
  }) as PendingRow | null

  if (!row) return Response.json({ error: 'not_found' }, { status: 404 })
  if (row.status !== 'pending' && row.status !== 'waiting_list') {
    return Response.json({ error: 'already_resolved', status: row.status })
  }

  const approved = body.decision === 'approve'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (prisma as any).agentPendingAction.update({
    where: { id: body.actionId },
    data: { status: approved ? 'approved' : 'rejected', resolvedAt: new Date() },
  })

  if (approved && row.payload) {
    const workerUrl = process.env.AGENT_WORKER_DIAGNOSTIC_URL?.replace(/\/$/, '')
    const internalToken = process.env.AGENT_INTERNAL_TOKEN
    if (workerUrl && internalToken) {
      try {
        await fetch(`${workerUrl}/staff-send`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${internalToken}`,
          },
          body: JSON.stringify({ actionId: body.actionId, payload: row.payload }),
          signal: AbortSignal.timeout(15_000),
        })
      } catch (err) {
        console.warn('[approve-api] worker dispatch failed:', err)
      }
    }
  }

  return Response.json({ ok: true, decision: body.decision })
}
