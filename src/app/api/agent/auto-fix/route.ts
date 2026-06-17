import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { isAutoFixEligible, autoFixIneligibleReason } from '@/lib/diagnostic/auto-fix-eligibility'

export const runtime = 'nodejs'

type AutoFixPayload = {
  title: string
  area: string
  severity: string
  detail: string
  signal?: string
  errorLog?: string
  affectedFiles?: string[]
}

/**
 * POST: Request an auto-fix for a specific issue.
 * Creates a pending action and notifies worker to dispatch Cursor cloud agent.
 */
export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const body = await req.json() as { issue?: AutoFixPayload; decision?: string; actionId?: string }

  // Handle approve/reject from UI
  if (body.actionId && body.decision) {
    return handleDecision(body.actionId, body.decision)
  }

  if (!body.issue?.title) {
    return Response.json({ error: 'issue.title required' }, { status: 400 })
  }

  if (!isAutoFixEligible(body.issue)) {
    return Response.json(
      { error: 'not_auto_fix_eligible', message: autoFixIneligibleReason(body.issue) },
      { status: 422 },
    )
  }

  const issue = body.issue
  const costEstimate = estimateCost(issue)
  const id = crypto.randomUUID()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (prisma as any).agentPendingAction.create({
    data: {
      id,
      type: 'auto_fix',
      payload: { ...issue, costEstimate },
      summary: `🔧 Auto-Fix: ${issue.title}\n${issue.detail?.slice(0, 100) ?? ''}\n💰 ~$${costEstimate.toFixed(2)}`,
      status: 'pending',
      costEstimate,
      businessId: 'ALMA_LIFESTYLE',
    },
  })

  // Notify worker to send Telegram approval card
  const workerUrl = process.env.AGENT_WORKER_DIAGNOSTIC_URL?.replace(/\/$/, '')
  const internalToken = process.env.AGENT_INTERNAL_TOKEN
  if (workerUrl && internalToken) {
    try {
      await fetch(`${workerUrl}/auto-fix-notify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${internalToken}`,
        },
        body: JSON.stringify({ actionId: id, issue: { ...issue, costEstimate } }),
        signal: AbortSignal.timeout(10_000),
      })
    } catch { /* worker notify is best-effort */ }
  }

  return Response.json({ ok: true, actionId: id, costEstimate })
}

/**
 * GET: List auto-fix actions (pending + recent resolved).
 */
export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actions = await (prisma as any).agentPendingAction.findMany({
    where: {
      type: 'auto_fix',
      createdAt: { gte: since },
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
  })

  return Response.json({
    actions: actions.map((a: Record<string, unknown>) => ({
      id: a.id,
      status: a.status,
      payload: a.payload,
      summary: a.summary,
      costEstimate: a.costEstimate,
      createdAt: a.createdAt,
      resolvedAt: a.resolvedAt,
      result: a.result,
    })),
  })
}

async function handleDecision(actionId: string, decision: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = await (prisma as any).agentPendingAction.findUnique({
    where: { id: actionId },
    select: { id: true, payload: true, status: true },
  })

  if (!row) return Response.json({ error: 'not_found' }, { status: 404 })
  if (row.status !== 'pending' && row.status !== 'waiting_list') {
    return Response.json({ error: 'already_resolved', status: row.status })
  }

  const approved = decision === 'approve'

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (prisma as any).agentPendingAction.update({
    where: { id: actionId },
    data: {
      status: approved ? 'approved' : 'rejected',
      resolvedAt: new Date(),
    },
  })

  if (approved) {
    const workerUrl = process.env.AGENT_WORKER_DIAGNOSTIC_URL?.replace(/\/$/, '')
    const internalToken = process.env.AGENT_INTERNAL_TOKEN
    if (workerUrl && internalToken) {
      try {
        await fetch(`${workerUrl}/auto-fix-run`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${internalToken}`,
          },
          body: JSON.stringify({ actionId, issue: row.payload }),
          signal: AbortSignal.timeout(10_000),
        })
      } catch { /* dispatch is async on worker */ }
    }
  }

  return Response.json({ ok: true, decision })
}

function estimateCost(issue: AutoFixPayload): number {
  const base = 0.10
  const severityMultiplier = issue.severity === 'high' ? 3 : issue.severity === 'medium' ? 2 : 1
  const complexityMultiplier = (issue.affectedFiles?.length ?? 1) > 3 ? 2.5 : 1.5
  return Math.round(base * severityMultiplier * complexityMultiplier * 100) / 100
}
