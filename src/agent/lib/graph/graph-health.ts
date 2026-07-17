/**
 * LG-4/LG-8 — graph program health, read from what production already writes.
 *
 * Two readers, both fail-open:
 *  - getTurnGraphHealth: aggregates the route spans (`__route__` tool events)
 *    the turns have been stamping since LG-1/3/4 — routine-graph handled
 *    share, action-graph stagings, and the LG-4 shadow AGREE RATE that gates
 *    the canary decision (roadmap: shadow → canary → on when agree ≥98% over
 *    ≥200 scored turns).
 *  - getCheckpointStoreHealth: row counts per thread family in the langgraph
 *    schema, so unbounded growth is visible before it hurts (cleanup cron
 *    trims >14d threads).
 */
import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export interface TurnGraphHealth {
  days: number
  turns: number
  routine: { handled: number; miss: number; off: number; handledShare: number }
  action: { staged: number }
  shadow: {
    recorded: number
    scored: number
    agreed: number
    agreeRate: number
    byKind: Record<string, { scored: number; agreed: number }>
  }
  /** Phase 33: the FULL 12-node owner-turn graph's shadow performance. */
  ownerGraph: {
    recorded: number
    scored: number
    agreed: number
    agreeRate: number
    /** disagreement label → count (fast_path | focus_binding | tool_groups | planned_tool). */
    disagreements: Record<string, number>
    /** Traces carrying all five required elements (focus/tool/guard/verify/final). */
    traceComplete: number
  }
  canaryReady: boolean
  canaryVerdict: string
}

const CANARY_MIN_SCORED = 200
const CANARY_MIN_AGREE = 0.98

export async function getTurnGraphHealth(days = 7): Promise<TurnGraphHealth | null> {
  try {
    const since = new Date(Date.now() - days * 86_400_000)
    const rows: Array<{ detail: unknown }> = await db.agentToolEvent.findMany({
      where: { toolName: '__route__', createdAt: { gte: since } },
      select: { detail: true },
      orderBy: { createdAt: 'desc' },
      take: 5000,
    })
    const health: TurnGraphHealth = {
      days,
      turns: rows.length,
      routine: { handled: 0, miss: 0, off: 0, handledShare: 0 },
      action: { staged: 0 },
      shadow: { recorded: 0, scored: 0, agreed: 0, agreeRate: 0, byKind: {} },
      ownerGraph: { recorded: 0, scored: 0, agreed: 0, agreeRate: 0, disagreements: {}, traceComplete: 0 },
      canaryReady: false,
      canaryVerdict: '',
    }
    for (const r of rows) {
      const d = (r.detail ?? {}) as {
        routineGraph?: string
        actionGraph?: string
        turnGraph?: {
          fastPath?: string
          agree?: boolean | null
          graph?: {
            trace?: Record<string, unknown>
            agreement?: { agree?: boolean | null; disagreements?: string[] }
          } | null
        } | null
      }
      if (d.routineGraph === 'handled') health.routine.handled++
      else if (d.routineGraph === 'miss') health.routine.miss++
      else health.routine.off++
      if (d.actionGraph === 'staged') health.action.staged++
      if (d.turnGraph) {
        health.shadow.recorded++
        const kind = d.turnGraph.fastPath ?? 'unknown'
        if (typeof d.turnGraph.agree === 'boolean') {
          health.shadow.scored++
          const k = (health.shadow.byKind[kind] ??= { scored: 0, agreed: 0 })
          k.scored++
          if (d.turnGraph.agree) {
            health.shadow.agreed++
            k.agreed++
          }
        }
        const g = d.turnGraph.graph
        if (g) {
          health.ownerGraph.recorded++
          const t = g.trace ?? {}
          const complete = ['selectedFocus', 'toolDecision', 'guardResult', 'verification', 'finalState']
            .every((key) => key in t)
          if (complete) health.ownerGraph.traceComplete++
          const a = g.agreement
          if (a && typeof a.agree === 'boolean') {
            health.ownerGraph.scored++
            if (a.agree) health.ownerGraph.agreed++
            else for (const label of a.disagreements ?? []) {
              health.ownerGraph.disagreements[label] = (health.ownerGraph.disagreements[label] ?? 0) + 1
            }
          }
        }
      }
    }
    const routineTotal = health.routine.handled + health.routine.miss
    health.routine.handledShare = routineTotal ? health.routine.handled / routineTotal : 0
    health.shadow.agreeRate = health.shadow.scored ? health.shadow.agreed / health.shadow.scored : 0
    health.ownerGraph.agreeRate = health.ownerGraph.scored ? health.ownerGraph.agreed / health.ownerGraph.scored : 0
    health.canaryReady =
      health.shadow.scored >= CANARY_MIN_SCORED && health.shadow.agreeRate >= CANARY_MIN_AGREE
    health.canaryVerdict = health.canaryReady
      ? `READY: agree ${(health.shadow.agreeRate * 100).toFixed(1)}% over ${health.shadow.scored} scored turns (≥${CANARY_MIN_SCORED} @ ≥${CANARY_MIN_AGREE * 100}%)`
      : `NOT YET: ${health.shadow.scored}/${CANARY_MIN_SCORED} scored turns, agree ${(health.shadow.agreeRate * 100).toFixed(1)}% (need ≥${CANARY_MIN_AGREE * 100}%)`
    return health
  } catch (err) {
    console.warn('[graph-health] turn health read failed open:', err instanceof Error ? err.message : err)
    return null
  }
}

export interface CheckpointStoreHealth {
  totalCheckpoints: number
  totalThreads: number
  /** Thread counts by family: turn conversations, wfrun/wfstep, lbrowse, duty, plan… */
  threadFamilies: Record<string, number>
}

export async function getCheckpointStoreHealth(): Promise<CheckpointStoreHealth | null> {
  try {
    const rows: Array<{ thread_id: string; n: bigint }> = await db.$queryRaw`
      SELECT thread_id, COUNT(*)::bigint AS n
      FROM langgraph.checkpoints
      GROUP BY thread_id
    `
    const families: Record<string, number> = {}
    let total = 0
    for (const r of rows) {
      total += Number(r.n)
      const m = /^([a-z_]+):/.exec(r.thread_id)
      const family = m ? m[1] : 'turn'
      families[family] = (families[family] ?? 0) + 1
    }
    return { totalCheckpoints: total, totalThreads: rows.length, threadFamilies: families }
  } catch (err) {
    console.warn('[graph-health] store health read failed open:', err instanceof Error ? err.message : err)
    return null
  }
}
