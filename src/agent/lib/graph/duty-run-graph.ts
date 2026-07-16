/**
 * LG-9 slice 1 — scheduled duties get durable graph threads.
 *
 * Every heartbeat tick (and any future scheduled duty: day-shift, watchdog…)
 * records its DECISION as one checkpoint on a per-day thread:
 *
 *   thread_id `duty:<dutyKey>:<ymd>` · one `apply_tick` super-step per tick
 *
 * What that buys:
 *  - "আজ heartbeat কী কী করল / কেন চুপ ছিল" is replayable from checkpoints —
 *    every quiet reason (off_hours / resting / unchanged / cap_reached) and
 *    every wake with its outcome + cost is on the chain, not just the last
 *    row of a log table;
 *  - the same LG-8 time-travel/debug story that turns already have now covers
 *    the autonomous scheduler: a misbehaving duty day is auditable step by
 *    step.
 *
 * Discipline: fail-open mirror (a checkpoint problem never touches the tick),
 * shared AGENT_LANGGRAPH_WORKFLOW gate — 'false' kill switch, 'true'
 * force-on, default ON in Vercel preview / OFF in production.
 */
import { StateGraph, Annotation, START, END } from '@langchain/langgraph'
import { getGraphCheckpointer, checkpointConfigFor } from '@/agent/lib/graph/graph-checkpointer'
import { isWorkflowGraphEnabled } from '@/agent/lib/graph/seo-batch-graph'

export const DUTY_RUN_NS = 'duty_run'

export interface DutyTick {
  /** What the duty decided this tick: a quiet reason, or 'wake'. */
  decision: string
  /** Wake outcome ('active' | 'blocked' | 'error') — null on quiet ticks. */
  outcome: string | null
  /** Short owner-readable summary (Bangla). */
  summary: string | null
  costUsd: number
  /** The conversation the wake ran in — null on quiet ticks. */
  conversationId: string | null
  /** Stamped by the graph node — identifies the post-node checkpoint. */
  tickNo?: number
}

const DutyRunState = Annotation.Root({
  tick: Annotation<DutyTick | null>({ reducer: (_a, b) => b, default: () => null }),
  tickCount: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
  wakes: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
  totalCostUsd: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
})

function buildGraph(checkpointer: NonNullable<ReturnType<typeof getGraphCheckpointer>>) {
  return new StateGraph(DutyRunState)
    .addNode('apply_tick', (s) => ({
      tickCount: 1,
      tick: s.tick ? { ...s.tick, tickNo: s.tickCount + 1 } : null,
      wakes: s.tick?.decision === 'wake' ? 1 : 0,
      totalCostUsd: s.tick?.costUsd ?? 0,
    }))
    .addEdge(START, 'apply_tick')
    .addEdge('apply_tick', END)
    .compile({ checkpointer })
}

function threadId(dutyKey: string, ymd: string): string {
  return `duty:${dutyKey}:${ymd}`
}

function threadConfig(dutyKey: string, ymd: string) {
  return checkpointConfigFor({ conversationId: threadId(dutyKey, ymd), turnId: null, namespace: DUTY_RUN_NS })
}

/** Mirror one duty tick. Fail-open: null when gated off / broken. */
export async function mirrorDutyTick(
  dutyKey: string,
  ymd: string,
  tick: DutyTick,
): Promise<number | null> {
  try {
    if (!isWorkflowGraphEnabled()) return null
    const checkpointer = getGraphCheckpointer()
    if (!checkpointer) return null
    const graph = buildGraph(checkpointer)
    const out = await graph.invoke({ tick }, threadConfig(dutyKey, ymd))
    const n = (out as { tickCount?: number }).tickCount ?? 0
    console.log(
      `[duty-run-graph] ${dutyKey}@${ymd} tick#${n} ${tick.decision}` +
        (tick.outcome ? ` outcome=${tick.outcome}` : '') +
        (tick.costUsd ? ` $${tick.costUsd.toFixed(4)}` : ''),
    )
    return n
  } catch (err) {
    console.warn('[duty-run-graph] mirror failed open:', err instanceof Error ? err.message : err)
    return null
  }
}

export interface DutyRunHistoryTick extends DutyTick {
  tickNo: number
  checkpointId: string | null
  createdAt: string | null
}

export interface DutyRunDaySummary {
  ticks: DutyRunHistoryTick[]
  wakes: number
  totalCostUsd: number
}

/**
 * The day's tick history (newest first) + running totals from the thread's
 * latest state. Fail-open: empty summary when gated off / no thread / error.
 */
export async function getDutyRunDay(
  dutyKey: string,
  ymd: string,
  limit = 100,
): Promise<DutyRunDaySummary> {
  const empty: DutyRunDaySummary = { ticks: [], wakes: 0, totalCostUsd: 0 }
  try {
    if (!isWorkflowGraphEnabled()) return empty
    const checkpointer = getGraphCheckpointer()
    if (!checkpointer) return empty
    const graph = buildGraph(checkpointer)
    const ticks: DutyRunHistoryTick[] = []
    let wakes = 0
    let totalCostUsd = 0
    for await (const snap of graph.getStateHistory({
      configurable: { thread_id: threadId(dutyKey, ymd) },
    })) {
      const v = (snap.values ?? {}) as { tick?: DutyTick | null; tickCount?: number; wakes?: number; totalCostUsd?: number }
      if (!v.tick) continue
      // Post-node checkpoints only (input/pre-node snapshots echo stale or
      // half-applied state) — same discipline as the other LG-6 readers.
      if ((snap.metadata as { source?: string } | undefined)?.source !== 'loop') continue
      if (v.tick.tickNo !== v.tickCount) continue
      if (ticks.length === 0) {
        wakes = v.wakes ?? 0
        totalCostUsd = v.totalCostUsd ?? 0
      }
      ticks.push({
        ...v.tick,
        tickNo: v.tickCount ?? 0,
        checkpointId: (snap.config?.configurable as { checkpoint_id?: string } | undefined)?.checkpoint_id ?? null,
        createdAt: snap.createdAt ?? null,
      })
      if (ticks.length >= limit) break
    }
    return { ticks, wakes, totalCostUsd }
  } catch (err) {
    console.warn('[duty-run-graph] history read failed open:', err instanceof Error ? err.message : err)
    return empty
  }
}
