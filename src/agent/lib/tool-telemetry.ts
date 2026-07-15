/**
 * Agent tool telemetry — fire-and-forget per-call event logging.
 * Writes to AgentToolEvent table; never blocks the turn.
 */
import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export interface ToolEventInput {
  surface?: 'owner' | 'cs' | 'scheduler'
  toolName: string
  success: boolean
  verified?: boolean
  errorClass?: string
  latencyMs?: number
  conversationId?: string | null
  businessId?: string
  // ── Phase 1 span fields (roadmap: turn → route → tool-call → approval → proof)
  /** AgentTurn.id — joins every span of one turn into a single trace. */
  turnId?: string | null
  /** Span kind. Default 'tool' keeps every legacy call site unchanged. */
  phase?: 'route' | 'tool' | 'approval' | 'proof'
  /** Stable machine error code (errorClass stays the coarse bucket). */
  errorCode?: string | null
  /** Structured span payload — see schema.prisma AgentToolEvent.detail. */
  detail?: Record<string, unknown> | null
}

export async function logToolEvent(input: ToolEventInput): Promise<void> {
  try {
    await db.agentToolEvent.create({
      data: {
        surface: input.surface ?? 'owner',
        toolName: input.toolName,
        success: input.success,
        verified: input.verified ?? false,
        errorClass: input.errorClass ?? null,
        latencyMs: input.latencyMs ?? 0,
        conversationId: input.conversationId ?? null,
        businessId: input.businessId ?? 'ALMA_LIFESTYLE',
        turnId: input.turnId ?? null,
        phase: input.phase ?? 'tool',
        errorCode: input.errorCode ?? null,
        detail: input.detail ?? undefined,
      },
    })
  } catch {
    // Fire-and-forget — never crash the turn
  }
}

/**
 * Route span (Phase 1): one row per owner turn recording WHAT the head was given —
 * selected tool groups, tool count, model, head tier and the behavior-artifact
 * versions. This is the missing half of every wrong-tool investigation: the tool
 * event says what the model called; this span says what it had to choose from.
 */
export async function logRouteSpan(opts: {
  conversationId?: string | null
  turnId?: string | null
  businessId?: string
  groups: readonly string[]
  toolCount: number
  modelId: string
  headTier?: string
  versions?: Record<string, string>
  /** Phase 3 router extras: router kind, packs, state signals, trim, parallel policy. */
  extras?: Record<string, unknown>
}): Promise<void> {
  void logToolEvent({
    surface: 'owner',
    toolName: '__route__',
    success: true,
    phase: 'route',
    conversationId: opts.conversationId,
    turnId: opts.turnId,
    businessId: opts.businessId,
    detail: {
      groups: [...opts.groups],
      toolCount: opts.toolCount,
      modelId: opts.modelId,
      headTier: opts.headTier ?? null,
      versions: opts.versions ?? null,
      ...(opts.extras ?? {}),
    },
  })
}

/**
 * Log a wrong-refusal event: agent said "can't do" but the relevant
 * tool group wasn't loaded (routing gap).
 */
export async function logRefusalEvent(opts: {
  conversationId?: string | null
  businessId?: string
}): Promise<void> {
  void logToolEvent({
    surface: 'owner',
    toolName: '__refusal__',
    success: false,
    errorClass: 'maybe_starved',
    conversationId: opts.conversationId,
    businessId: opts.businessId,
  })
}

/**
 * Aggregate tool events for a date range (for scorecard).
 */
export async function aggregateToolEvents(
  startDate: Date,
  endDate: Date,
  businessId = 'ALMA_LIFESTYLE',
): Promise<{
  totalCalls: number
  failCount: number
  failRate: number
  verifiedCount: number
  verifiedRate: number
  refusalCount: number
  p95LatencyMs: number
  topErrors: { errorClass: string; count: number }[]
  perTool: { toolName: string; calls: number; fails: number; avgLatencyMs: number }[]
}> {
  const events = await db.agentToolEvent.findMany({
    where: {
      businessId,
      ts: { gte: startDate, lte: endDate },
    },
    orderBy: { ts: 'asc' },
  })

  const total = events.length
  const refusals = events.filter((e: { toolName: string }) => e.toolName === '__refusal__')
  // Real tool executions only — route/approval/proof spans (Phase 1) and refusal
  // markers must not skew per-tool fail/latency stats.
  const real = events.filter(
    (e: { toolName: string; phase?: string }) =>
      e.toolName !== '__refusal__' && (e.phase ?? 'tool') === 'tool',
  )
  const fails = real.filter((e: { success: boolean }) => !e.success)
  const verified = real.filter((e: { verified: boolean }) => e.verified)
  const latencies = real.map((e: { latencyMs: number }) => e.latencyMs).sort((a: number, b: number) => a - b)
  const p95Idx = Math.floor(latencies.length * 0.95)

  const errorMap = new Map<string, number>()
  for (const e of fails) {
    const cls = (e as { errorClass?: string }).errorClass ?? 'unknown'
    errorMap.set(cls, (errorMap.get(cls) ?? 0) + 1)
  }

  const toolMap = new Map<string, { calls: number; fails: number; totalLatency: number }>()
  for (const e of real) {
    const entry = (e as { toolName: string; success: boolean; latencyMs: number })
    const existing = toolMap.get(entry.toolName) ?? { calls: 0, fails: 0, totalLatency: 0 }
    existing.calls++
    if (!entry.success) existing.fails++
    existing.totalLatency += entry.latencyMs
    toolMap.set(entry.toolName, existing)
  }

  return {
    totalCalls: total,
    failCount: fails.length,
    failRate: real.length > 0 ? Math.round((fails.length / real.length) * 100) : 0,
    verifiedCount: verified.length,
    verifiedRate: real.length > 0 ? Math.round((verified.length / real.length) * 100) : 0,
    refusalCount: refusals.length,
    p95LatencyMs: latencies[p95Idx] ?? 0,
    topErrors: [...errorMap.entries()]
      .map(([errorClass, count]) => ({ errorClass, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
    perTool: [...toolMap.entries()]
      .map(([toolName, s]) => ({
        toolName,
        calls: s.calls,
        fails: s.fails,
        avgLatencyMs: Math.round(s.totalLatency / s.calls),
      }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 30),
  }
}
