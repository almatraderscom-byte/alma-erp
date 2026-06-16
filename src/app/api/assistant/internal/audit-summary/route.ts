/**
 * GET /api/assistant/internal/audit-summary?since=ISO
 * Returns security/audit metrics: tool usage, failures, costs, actions.
 */
import { NextRequest, NextResponse } from 'next/server'
import { verifyAgentInternalToken } from '@/lib/agent-internal-auth'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!verifyAgentInternalToken(token)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const since = req.nextUrl.searchParams.get('since') ?? new Date(Date.now() - 7 * 86_400_000).toISOString()
  const sinceDate = new Date(since)

  try {
    const [toolCalls, actions, costEvents] = await Promise.all([
      db.agentToolCall.findMany({
        where: { createdAt: { gte: sinceDate } },
        select: { toolName: true, status: true, durationMs: true },
      }),
      db.agentPendingAction.findMany({
        where: { createdAt: { gte: sinceDate } },
        select: { type: true, status: true },
      }),
      db.agentCostEvent.findMany({
        where: { createdAt: { gte: sinceDate } },
        select: { provider: true, costUsd: true, kind: true },
      }),
    ])

    const toolStats: Record<string, { calls: number; errors: number; avgMs: number }> = {}
    for (const tc of toolCalls) {
      if (!toolStats[tc.toolName]) toolStats[tc.toolName] = { calls: 0, errors: 0, avgMs: 0 }
      toolStats[tc.toolName].calls++
      if (tc.status === 'error') toolStats[tc.toolName].errors++
      toolStats[tc.toolName].avgMs += (tc.durationMs ?? 0)
    }
    for (const name of Object.keys(toolStats)) {
      toolStats[name].avgMs = Math.round(toolStats[name].avgMs / toolStats[name].calls)
    }

    const topTools = Object.entries(toolStats)
      .sort(([, a], [, b]) => b.calls - a.calls)
      .slice(0, 15)
      .map(([name, s]) => ({ name, ...s }))

    const actionsByStatus: Record<string, number> = {}
    for (const a of actions) {
      actionsByStatus[a.status] = (actionsByStatus[a.status] ?? 0) + 1
    }

    const costByProvider: Record<string, number> = {}
    let totalCost = 0
    for (const c of costEvents) {
      costByProvider[c.provider] = (costByProvider[c.provider] ?? 0) + (c.costUsd ?? 0)
      totalCost += (c.costUsd ?? 0)
    }

    return NextResponse.json({
      period: { since: sinceDate.toISOString(), until: new Date().toISOString() },
      tools: {
        totalCalls: toolCalls.length,
        totalErrors: toolCalls.filter((t: { status: string }) => t.status === 'error').length,
        top: topTools,
      },
      actions: { total: actions.length, byStatus: actionsByStatus },
      cost: { totalUsd: Math.round(totalCost * 1000) / 1000, byProvider: costByProvider },
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
