/**
 * GET /api/assistant/internal/health — lightweight liveness for VPS worker ping.
 * Auth: AGENT_INTERNAL_TOKEN only.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'

function checkToken(req: NextRequest): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN
  if (!expected) return false
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  } catch (err) {
    console.warn('[health] token compare failed:', err instanceof Error ? err.message : err)
    return false
  }
}

export async function GET(req: NextRequest) {
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const disabled = requireAgentEnabled()
  if (disabled) {
    return NextResponse.json({ ok: false, agentEnabled: false }, { status: 503 })
  }

  let db = false
  let dbError: string | null = null
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (prisma as any).agentHeartbeat.findFirst({ select: { service: true } })
    db = true
  } catch (err) {
    db = false
    dbError = err instanceof Error ? err.message : String(err)
  }

  const now = new Date()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dbHb = prisma as any
  try {
    await dbHb.agentHeartbeat.upsert({
      where: { service: 'app-health' },
      create: { service: 'app-health', lastBeatAt: now },
      update: { lastBeatAt: now },
    })
  } catch (err) {
    console.warn('[health] heartbeat upsert failed (table may not exist yet):', err instanceof Error ? err.message : err)
  }

  // LangGraph program health (fail-open): checkpoint-store size by thread
  // family + turn-graph shares — gates are live in production, so unbounded
  // growth or a silent mirror failure must show up HERE, not in an incident.
  let graph: unknown = null
  try {
    const { getCheckpointStoreHealth, getTurnGraphHealth } = await import('@/agent/lib/graph/graph-health')
    const [store, turns] = await Promise.all([getCheckpointStoreHealth(), getTurnGraphHealth(1)])
    graph = {
      store,
      today: turns
        ? {
            turns: turns.turns,
            routineHandledShare: turns.routine.handledShare,
            shadowAgreeRate: turns.shadow.agreeRate,
            scored: turns.shadow.scored,
          }
        : null,
    }
  } catch { /* health must never fail on the graph block */ }

  return NextResponse.json({
    ok: db,
    db,
    ...(dbError ? { dbError } : {}),
    agentEnabled: true,
    graph,
    timestamp: now.toISOString(),
  })
}
