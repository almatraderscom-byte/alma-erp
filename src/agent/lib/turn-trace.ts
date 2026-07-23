/**
 * Per-turn trace spine (audit P0-1 — decision lineage).
 *
 * One owner turn already leaves durable records at every authority stage:
 *   admission/turn   → AgentTurn (status, started/finished, versions)
 *   route/tool/guard → AgentToolEvent span rows (phase, guard decision detail)
 *   cost governor    → AgentCostEvent rows (per provider call, conversation-scoped)
 *   stream/events    → AgentTurnEvent rows (SSE replay log)
 *
 * This module ASSEMBLES those records into one typed Trace via the pure
 * SPEC-191 core (`@/agent/observability/trace`), keyed by the turn id as the
 * correlationId — so any turn can be reconstructed: which stages ran, what the
 * guard decided, what the models cost. Read-only; adds zero work to the hot
 * path. Fail-closed: an unknown turn id returns ok:false, never a guess.
 */
import { prisma } from '@/lib/prisma'
import { buildTrace, type Span, type TraceResult } from '@/agent/observability/trace'

export interface TurnTraceSummary {
  turnId: string
  conversationId: string
  status: string
  startedAt: string
  finishedAt: string | null
  /** Versions of prompt/tool-manifest/router/workflow live when the turn ran. */
  versions: unknown
  spanCount: number
  toolCalls: number
  guardBlocks: number
  costUsd: number
  trace: TraceResult
}

function spanStatus(success: boolean, errorCode?: string | null): Span['status'] {
  if (success) return 'ok'
  if (errorCode === 'needs_approval') return 'needs_approval'
  if (errorCode?.startsWith('guard_') || errorCode === 'policy_denied') return 'denied'
  return 'failed'
}

/** Assemble the full decision trace for one turn. */
export async function assembleTurnTrace(turnId: string): Promise<TurnTraceSummary | null> {
  const turn = await prisma.agentTurn.findUnique({ where: { id: turnId } })
  if (!turn) return null

  const startMs = turn.startedAt.getTime()
  const endCap = turn.finishedAt?.getTime() ?? Date.now()

  const [toolEvents, costEvents] = await Promise.all([
    prisma.agentToolEvent.findMany({
      where: { turnId },
      orderBy: { ts: 'asc' },
      take: 500,
    }),
    prisma.agentCostEvent.findMany({
      where: {
        conversationId: turn.conversationId,
        occurredAt: { gte: turn.startedAt, lte: new Date(endCap + 60_000) },
      },
      orderBy: { occurredAt: 'asc' },
      take: 100,
    }),
  ])

  const spans: Span[] = []

  // Stage 1 — admission: the turn itself.
  spans.push({
    spanId: `turn:${turn.id}`,
    component: 'admission.turn',
    correlationId: turnId,
    status: turn.status === 'error' ? 'failed' : 'ok',
    startMs,
    endMs: endCap,
  })

  // Stage 2..n — route / guard / tool / approval / proof spans.
  let guardBlocks = 0
  for (const ev of toolEvents) {
    const detail = (ev.detail ?? {}) as Record<string, unknown>
    const status = spanStatus(ev.success, ev.errorCode)
    if (status === 'denied' || status === 'needs_approval') guardBlocks++
    const s = ev.ts.getTime()
    spans.push({
      spanId: `tool-event:${ev.id}`,
      component: `${ev.phase}.${ev.toolName}`,
      correlationId: turnId,
      status,
      startMs: Math.max(startMs, s - ev.latencyMs),
      endMs: s,
      reasonCodes: [
        ...(ev.errorCode ? [ev.errorCode] : []),
        ...(typeof detail.guardReason === 'string' ? [`guard:${detail.guardReason}`] : []),
        ...(typeof detail.ladderVerdict === 'string' ? [`ladder:${detail.ladderVerdict}`] : []),
      ],
    })
  }

  // Stage n+1 — cost governor lineage: every provider spend inside the window.
  let costUsd = 0
  for (const ce of costEvents) {
    costUsd += Number(ce.costUsd)
    const t = ce.occurredAt.getTime()
    spans.push({
      spanId: `cost:${ce.id}`,
      component: `cost.${ce.provider}`,
      correlationId: turnId,
      status: 'ok',
      startMs: Math.max(startMs, t),
      endMs: Math.max(startMs, t),
    })
  }

  return {
    turnId,
    conversationId: turn.conversationId,
    status: turn.status,
    startedAt: turn.startedAt.toISOString(),
    finishedAt: turn.finishedAt?.toISOString() ?? null,
    versions: turn.versions ?? null,
    spanCount: spans.length,
    toolCalls: toolEvents.length,
    guardBlocks,
    costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
    trace: buildTrace(turnId, spans),
  }
}
