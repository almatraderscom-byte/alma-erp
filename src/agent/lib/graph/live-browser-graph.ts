/**
 * LG-6 slice 3 — live-browser sessions get a durable graph thread.
 *
 * Every live_browser_look / live_browser_act step in a conversation is
 * mirrored as one `apply_step` super-step on the LG-2 checkpointer:
 *
 *   thread_id `lbrowse:<conversationId>` · one checkpoint per browser step
 *
 * What that buys:
 *  - the whole browsing session is replayable (`getLiveBrowserGraphHistory`)
 *    — "কোন পেজে কী করেছিলে/দেখেছিলে" answered from checkpoints, not memory;
 *  - a crashed/limit-cut turn can RESUME from the last checkpoint: the next
 *    turn's first look reads the thread and knows where the session left off;
 *  - scroll telemetry (y / pageHeight / atBottom) is part of every step, so
 *    "did the model actually read the whole page" is auditable (owner report
 *    2026-07-16: the model didn't scroll and missed below-fold content).
 *
 * Discipline: fail-open mirror (a checkpoint problem never touches the live
 * turn), shared AGENT_LANGGRAPH_WORKFLOW gate — 'false' kill switch, 'true'
 * force-on, default ON in Vercel preview / OFF in production.
 */
import { StateGraph, Annotation, START, END } from '@langchain/langgraph'
import { getGraphCheckpointer, checkpointConfigFor } from '@/agent/lib/graph/graph-checkpointer'
import { isWorkflowGraphEnabled } from '@/agent/lib/graph/seo-batch-graph'

export const LIVE_BROWSER_NS = 'live_browser'

export interface LiveBrowserStep {
  /** 'look' | act verb ('click', 'type', 'scroll', …). */
  action: string
  /** Page URL after the step (orientation anchor). */
  url: string | null
  /** Target/detail: clicked text, typed field, scroll pixels, find query… */
  detail: string | null
  /** Scroll telemetry when the extension reported it. */
  scrollY: number | null
  pageHeight: number | null
  atBottom: boolean | null
  /** look: how much of the page text the model actually received. */
  textRead: number | null
  ok: boolean
  /** Stamped by the graph node — identifies the post-node checkpoint. */
  stepNo?: number
}

const LiveBrowserState = Annotation.Root({
  step: Annotation<LiveBrowserStep | null>({ reducer: (_a, b) => b, default: () => null }),
  stepCount: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
  lastUrl: Annotation<string>({ reducer: (_a, b) => b || _a, default: () => '' }),
})

function buildGraph(checkpointer: NonNullable<ReturnType<typeof getGraphCheckpointer>>) {
  return new StateGraph(LiveBrowserState)
    .addNode('apply_step', (s) => {
      const n = s.stepCount + 1
      // Re-write the step WITH its ordinal: the history reader picks exactly
      // the post-node checkpoint of each invoke by step.stepNo === stepCount
      // (the pre-node/input snapshots carry an unstamped or stale step).
      return {
        stepCount: 1,
        step: s.step ? { ...s.step, stepNo: n } : null,
        lastUrl: s.step?.url ?? '',
      }
    })
    .addEdge(START, 'apply_step')
    .addEdge('apply_step', END)
    .compile({ checkpointer })
}

function threadConfig(conversationId: string) {
  return checkpointConfigFor({
    conversationId: `lbrowse:${conversationId}`,
    turnId: null,
    namespace: LIVE_BROWSER_NS,
  })
}

/** Mirror one browser step. Fail-open: null when gated off / broken. */
export async function mirrorLiveBrowserStep(
  conversationId: string,
  step: LiveBrowserStep,
): Promise<number | null> {
  try {
    if (!conversationId || conversationId === 'na') return null
    if (!isWorkflowGraphEnabled()) return null
    const checkpointer = getGraphCheckpointer()
    if (!checkpointer) return null
    const graph = buildGraph(checkpointer)
    const out = await graph.invoke({ step }, threadConfig(conversationId))
    const n = (out as { stepCount?: number }).stepCount ?? 0
    console.log(
      `[live-browser-graph] conv=${conversationId} step#${n} ${step.action} url=${step.url ?? '-'} ` +
        (step.scrollY !== null ? `scroll=${step.scrollY}/${step.pageHeight ?? '?'}${step.atBottom ? ' bottom' : ''}` : ''),
    )
    return n
  } catch (err) {
    console.warn('[live-browser-graph] mirror failed open:', err instanceof Error ? err.message : err)
    return null
  }
}

export interface LiveBrowserHistoryStep extends LiveBrowserStep {
  stepNo: number
  checkpointId: string | null
  createdAt: string | null
}

/**
 * The session's step history, newest first, from the thread's checkpoint
 * chain. Fail-open: [] when gated off / no thread / any error.
 */
export async function getLiveBrowserGraphHistory(
  conversationId: string,
  limit = 60,
): Promise<LiveBrowserHistoryStep[]> {
  try {
    if (!isWorkflowGraphEnabled()) return []
    const checkpointer = getGraphCheckpointer()
    if (!checkpointer) return []
    const graph = buildGraph(checkpointer)
    const steps: LiveBrowserHistoryStep[] = []
    for await (const snap of graph.getStateHistory({
      configurable: { thread_id: `lbrowse:${conversationId}` },
    })) {
      const v = (snap.values ?? {}) as { step?: LiveBrowserStep | null; stepCount?: number }
      if (!v.step) continue // seed checkpoint
      // Every invoke leaves ~3 snapshots: input (previous invoke's final state),
      // pre-node loop (new step written, counter not bumped) and post-node loop.
      // The real step record is the post-node one — 'loop' source AND the
      // node-stamped ordinal matching the bumped counter (input snapshots echo
      // the PREVIOUS stamped step, so the source check alone is not enough).
      if ((snap.metadata as { source?: string } | undefined)?.source !== 'loop') continue
      if (v.step.stepNo !== v.stepCount) continue
      steps.push({
        ...v.step,
        stepNo: v.stepCount ?? 0,
        checkpointId: (snap.config?.configurable as { checkpoint_id?: string } | undefined)?.checkpoint_id ?? null,
        createdAt: snap.createdAt ?? null,
      })
      if (steps.length >= limit) break
    }
    return steps
  } catch (err) {
    console.warn('[live-browser-graph] history read failed open:', err instanceof Error ? err.message : err)
    return []
  }
}
