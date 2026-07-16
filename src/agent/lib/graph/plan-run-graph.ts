/**
 * LG-9 slice 2 — plan-driver runs get durable graph threads.
 *
 * The autodrive loop (driver.ts) executes one plan step per tick; each tick's
 * OUTCOME is one checkpoint on the plan's thread:
 *
 *   thread_id `plan:<planId>` · one `apply_tick` super-step per drive tick
 *
 * What that buys: a multi-day plan ("৭ দিনে নতুন ক্যাম্পেইন দাঁড় করাও") is
 * replayable step by step — which step ran, what it cost, where it blocked on
 * an approval card, why it escalated — from checkpoints instead of scattered
 * log rows. Same LG-8 "কী হয়েছিল" primitive the workflows already have.
 *
 * Discipline: fail-open mirror (a checkpoint problem never touches the drive
 * tick), shared AGENT_LANGGRAPH_WORKFLOW gate — 'false' kill switch, 'true'
 * force-on, default ON in Vercel preview / OFF in production.
 */
import { StateGraph, Annotation, START, END } from '@langchain/langgraph'
import { getGraphCheckpointer, checkpointConfigFor } from '@/agent/lib/graph/graph-checkpointer'
import { isWorkflowGraphEnabled } from '@/agent/lib/graph/seo-batch-graph'

export const PLAN_RUN_NS = 'plan_run'

export interface PlanDriveTick {
  /** drivePlan outcome: step-done | step-failed | blocked-approval | escalated-* … */
  outcome: string
  /** The step the tick worked on (action text) — null for plan-level outcomes. */
  stepAction: string | null
  /** Failure text / escalation note / step summary (short). */
  detail: string | null
  costTaka: number
  /** Stamped by the graph node — identifies the post-node checkpoint. */
  tickNo?: number
}

const PlanRunState = Annotation.Root({
  tick: Annotation<PlanDriveTick | null>({ reducer: (_a, b) => b, default: () => null }),
  tickCount: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
  stepsDone: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
  totalCostTaka: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
})

function buildGraph(checkpointer: NonNullable<ReturnType<typeof getGraphCheckpointer>>) {
  return new StateGraph(PlanRunState)
    .addNode('apply_tick', (s) => ({
      tickCount: 1,
      tick: s.tick ? { ...s.tick, tickNo: s.tickCount + 1 } : null,
      stepsDone: s.tick?.outcome === 'step-done' ? 1 : 0,
      totalCostTaka: s.tick?.costTaka ?? 0,
    }))
    .addEdge(START, 'apply_tick')
    .addEdge('apply_tick', END)
    .compile({ checkpointer })
}

function threadConfig(planId: string) {
  return checkpointConfigFor({ conversationId: `plan:${planId}`, turnId: null, namespace: PLAN_RUN_NS })
}

/** Mirror one drive tick. Fail-open: null when gated off / broken. */
export async function mirrorPlanDriveTick(planId: string, tick: PlanDriveTick): Promise<number | null> {
  try {
    if (!isWorkflowGraphEnabled()) return null
    const checkpointer = getGraphCheckpointer()
    if (!checkpointer) return null
    const graph = buildGraph(checkpointer)
    const out = await graph.invoke({ tick }, threadConfig(planId))
    const n = (out as { tickCount?: number }).tickCount ?? 0
    console.log(
      `[plan-run-graph] plan=${planId} tick#${n} ${tick.outcome}` +
        (tick.stepAction ? ` step="${tick.stepAction.slice(0, 60)}"` : ''),
    )
    return n
  } catch (err) {
    console.warn('[plan-run-graph] mirror failed open:', err instanceof Error ? err.message : err)
    return null
  }
}

export interface PlanRunHistoryTick extends PlanDriveTick {
  tickNo: number
  checkpointId: string | null
  createdAt: string | null
}

export interface PlanRunSummary {
  ticks: PlanRunHistoryTick[]
  stepsDone: number
  totalCostTaka: number
}

/**
 * The plan's drive history (newest first) + running totals. Fail-open: empty
 * summary when gated off / no thread / any error.
 */
export async function getPlanRunHistory(planId: string, limit = 100): Promise<PlanRunSummary> {
  const empty: PlanRunSummary = { ticks: [], stepsDone: 0, totalCostTaka: 0 }
  try {
    if (!isWorkflowGraphEnabled()) return empty
    const checkpointer = getGraphCheckpointer()
    if (!checkpointer) return empty
    const graph = buildGraph(checkpointer)
    const ticks: PlanRunHistoryTick[] = []
    let stepsDone = 0
    let totalCostTaka = 0
    for await (const snap of graph.getStateHistory({
      configurable: { thread_id: `plan:${planId}` },
    })) {
      const v = (snap.values ?? {}) as { tick?: PlanDriveTick | null; tickCount?: number; stepsDone?: number; totalCostTaka?: number }
      if (!v.tick) continue
      // Post-node checkpoints only — same discipline as the other readers.
      if ((snap.metadata as { source?: string } | undefined)?.source !== 'loop') continue
      if (v.tick.tickNo !== v.tickCount) continue
      if (ticks.length === 0) {
        stepsDone = v.stepsDone ?? 0
        totalCostTaka = v.totalCostTaka ?? 0
      }
      ticks.push({
        ...v.tick,
        tickNo: v.tickCount ?? 0,
        checkpointId: (snap.config?.configurable as { checkpoint_id?: string } | undefined)?.checkpoint_id ?? null,
        createdAt: snap.createdAt ?? null,
      })
      if (ticks.length >= limit) break
    }
    return { ticks, stepsDone, totalCostTaka }
  } catch (err) {
    console.warn('[plan-run-graph] history read failed open:', err instanceof Error ? err.message : err)
    return empty
  }
}
