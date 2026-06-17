import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { queryCostSumBetween } from '@/agent/lib/cost-db'
import { todayYmdDhaka, dhakaDayBounds } from '@/lib/agent-api/dhaka-date'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  try {
    const todayStr = todayYmdDhaka()
    const { start: todayStart, end: todayEnd } = dhakaDayBounds(todayStr)

    const [
      memoryCount,
      activePlaybookCount,
      proposedPlaybookCount,
      knowledgeCount,
      kvRows,
      todayCostUsd,
    ] = await Promise.all([
      prisma.agentMemory.count(),
      prisma.agentPlaybook.count({ where: { status: 'active' } }),
      prisma.agentPlaybook.count({ where: { status: 'proposed' } }),
      prisma.agentKnowledge.count(),
      prisma.agentKvSetting.findMany({
        where: { key: { in: ['worker.lastKnowledgeBuild', 'worker.lastSessionSummary'] } },
      }),
      queryCostSumBetween(todayStart, todayEnd),
    ])

    const kvMap = Object.fromEntries(kvRows.map(r => [r.key, r.value]))

    return Response.json({
      memoryCount,
      activePlaybookCount,
      proposedPlaybookCount,
      knowledgeCount,
      lastKnowledgeBuild: kvMap['worker.lastKnowledgeBuild'] ?? null,
      lastSessionSummary: kvMap['worker.lastSessionSummary'] ?? null,
      todayDhakaDate: todayStr,
      todayCostUsd: Math.round(todayCostUsd * 1_000_000) / 1_000_000,
    })
  } catch (err) {
    console.error('[agent/brain-stats]', err)
    return Response.json({
      error: 'brain_stats_failed',
      message: err instanceof Error ? err.message : 'Unknown error',
    }, { status: 500 })
  }
}
