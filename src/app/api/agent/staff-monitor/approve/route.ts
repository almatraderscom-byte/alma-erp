import { type NextRequest } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { recordApproval, recordRejection } from '@/agent/lib/trust-engine'

export const runtime = 'nodejs'

function verifyInternalToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch { return false }
}

async function proxyActionDecision(actionId: string, decision: 'approve' | 'reject', token: string) {
  const appUrl = process.env.APP_URL?.replace(/\/$/, '')
  if (!appUrl) return Response.json({ error: 'APP_URL not configured' }, { status: 500 })

  const path = decision === 'approve' ? 'approve' : 'reject'
  const res = await fetch(`${appUrl}/api/assistant/actions/${actionId}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(25_000),
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    return Response.json({ error: data.error ?? `action_${path}_failed`, status: res.status }, { status: res.status })
  }
  return Response.json({ ok: true, decision, ...data })
}

async function approveStaffAutoMessage(
  actionId: string,
  decision: 'approve' | 'reject',
  row: { payload: Record<string, unknown> | null; type: string; businessId: string | null },
) {
  const approved = decision === 'approve'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (prisma as any).agentPendingAction.update({
    where: { id: actionId },
    data: { status: approved ? 'approved' : 'rejected', resolvedAt: new Date() },
  })

  const trustBiz = row.businessId ?? 'ALMA_LIFESTYLE'
  if (approved) {
    void recordApproval('staff', row.type, trustBiz).catch(() => {})
  } else {
    void recordRejection('staff', row.type, trustBiz).catch(() => {})
  }

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
          body: JSON.stringify({ actionId, payload: row.payload }),
          signal: AbortSignal.timeout(15_000),
        })
      } catch (err) {
        console.warn('[approve-api] worker dispatch failed:', err)
      }
    }
  }

  return Response.json({ ok: true, decision })
}

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

  const internalToken = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!verifyInternalToken(internalToken)) {
    return Response.json({ error: 'server_misconfigured' }, { status: 500 })
  }

  type PendingRow = {
    id: string
    payload: Record<string, unknown> | null
    status: string
    type: string
    businessId: string | null
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = await (prisma as any).agentPendingAction.findUnique({
    where: { id: body.actionId },
    select: { id: true, payload: true, status: true, type: true, businessId: true },
  }) as PendingRow | null

  if (!row) return Response.json({ error: 'not_found' }, { status: 404 })
  if (row.status !== 'pending' && row.status !== 'waiting_list') {
    return Response.json({ error: 'already_resolved', status: row.status })
  }

  if (row.type === 'staff_auto_message') {
    return approveStaffAutoMessage(body.actionId, body.decision, row)
  }

  return proxyActionDecision(body.actionId, body.decision, internalToken)
}
