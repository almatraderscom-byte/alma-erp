/**
 * LG-6 slice 1 — the client SEO batch (the roadmap's named checkpoint+resume
 * pilot) gets a DURABLE GRAPH THREAD alongside its WorkflowRun row.
 *
 * Every state transition the battle-tested reducer makes is mirrored into a
 * LangGraph thread on the LG-2 Postgres checkpointer:
 *
 *   thread_id `wfrun:<runId>` · ns `client_seo_batch` · durability 'sync'
 *   one `apply_event` super-step per ClientSeoBatchEvent
 *
 * What that buys (and why this is the LG-6 pilot):
 *  - every step is a parent-chained checkpoint → the batch's full history is
 *    replayable (`getSeoBatchGraphHistory`) — the LG-8 "এই কাজে কী হয়েছিল"
 *    primitive, and CI replay later;
 *  - the facts survive independently of the WorkflowRun JSON blob — a
 *    crashed/half-written row can be reconstructed from the thread;
 *  - the reducer stays the single source of TRUTH for transitions (no logic
 *    fork): the graph node calls the SAME reduceClientSeoBatch.
 *
 * Discipline (same as every LG slice): mirror is fail-open — any checkpointer
 * problem logs one line and the legacy WorkflowRun flow proceeds untouched.
 * A consistency check compares mirrored facts against the run's facts and
 * warns on drift (the LG-4 shadow pattern: measure before any cutover).
 *
 * Gate: AGENT_LANGGRAPH_WORKFLOW — 'false' kill switch, 'true' force-on,
 * default ON in Vercel preview / OFF in production.
 */
import { StateGraph, Annotation, START, END } from '@langchain/langgraph'
import {
  reduceClientSeoBatch,
  clientSeoBatchStateLabel,
  type ClientSeoBatchEvent,
  type ClientSeoBatchFacts,
} from '@/agent/lib/client-seo-batch-state'
import { getGraphCheckpointer, checkpointConfigFor } from '@/agent/lib/graph/graph-checkpointer'

export const SEO_BATCH_NS = 'client_seo_batch'

export function isWorkflowGraphEnabled(
  flag = process.env.AGENT_LANGGRAPH_WORKFLOW,
  vercelEnv = process.env.VERCEL_ENV,
): boolean {
  if (flag === 'true') return true
  if (flag === 'false') return false
  return vercelEnv === 'preview'
}

const SeoBatchState = Annotation.Root({
  facts: Annotation<ClientSeoBatchFacts | null>({ reducer: (_a, b) => b, default: () => null }),
  event: Annotation<ClientSeoBatchEvent | null>({ reducer: (_a, b) => b, default: () => null }),
  stateLabel: Annotation<string>({ reducer: (_a, b) => b, default: () => '' }),
})

function buildGraph(checkpointer: NonNullable<ReturnType<typeof getGraphCheckpointer>>) {
  return new StateGraph(SeoBatchState)
    .addNode('apply_event', (s) => {
      // No event = seed step (facts arrive verbatim). With an event, the SAME
      // reducer the legacy row uses computes the next facts — one truth.
      const facts = s.event && s.facts ? reduceClientSeoBatch(s.facts, s.event) : s.facts
      return { facts, stateLabel: facts ? clientSeoBatchStateLabel(facts) : '' }
    })
    .addEdge(START, 'apply_event')
    .addEdge('apply_event', END)
    .compile({ checkpointer })
}

function threadConfig(runId: string) {
  return checkpointConfigFor({ conversationId: `wfrun:${runId}`, turnId: null, namespace: SEO_BATCH_NS })
}

/**
 * Mirror one transition into the run's graph thread. `facts` is the state the
 * legacy reducer STARTED from and `event` the transition — the node re-derives
 * the next facts with the same reducer, so drift between the two engines is
 * detectable, not assumed away. Pass event=null to seed a new thread.
 * Fail-open: returns the mirrored state label, or null when gated off/broken.
 */
export async function mirrorSeoBatchTransition(opts: {
  runId: string
  facts: ClientSeoBatchFacts
  event: ClientSeoBatchEvent | null
  /** The state label the LEGACY path computed — compared for drift. */
  legacyStateLabel?: string
}): Promise<string | null> {
  try {
    if (!isWorkflowGraphEnabled()) return null
    const checkpointer = getGraphCheckpointer()
    if (!checkpointer) return null
    const graph = buildGraph(checkpointer)
    const out = await graph.invoke({ facts: opts.facts, event: opts.event }, threadConfig(opts.runId))
    const label = (out as { stateLabel?: string }).stateLabel ?? ''
    if (opts.legacyStateLabel && label && label !== opts.legacyStateLabel) {
      // Same reducer, same inputs — a drift here means the two engines were fed
      // different facts (a stale row, a lost write). Exactly what the pilot
      // must surface before any cutover.
      console.warn(
        `[seo-batch-graph] DRIFT run=${opts.runId} graph="${label}" legacy="${opts.legacyStateLabel}"`,
      )
    } else {
      console.log(`[seo-batch-graph] run=${opts.runId} step=${label || 'seed'} event=${opts.event?.type ?? 'seed'}`)
    }
    return label || null
  } catch (err) {
    console.warn('[seo-batch-graph] mirror failed open:', err instanceof Error ? err.message : err)
    return null
  }
}

export interface SeoBatchHistoryStep {
  stateLabel: string
  eventType: string | null
  currentIndex: number | null
  checkpointId: string | null
  createdAt: string | null
}

/**
 * The batch's step-by-step history, newest first — read straight from the
 * thread's checkpoint chain (LG-8's owner-facing replay primitive).
 * Fail-open: [] when gated off / no thread / any error.
 */
export async function getSeoBatchGraphHistory(runId: string, limit = 50): Promise<SeoBatchHistoryStep[]> {
  try {
    if (!isWorkflowGraphEnabled()) return []
    const checkpointer = getGraphCheckpointer()
    if (!checkpointer) return []
    const graph = buildGraph(checkpointer)
    const steps: SeoBatchHistoryStep[] = []
    // History filters by thread only: the root graph persists its checkpoints
    // under the ROOT namespace ('') regardless of the configurable ns hint, so
    // an ns-filtered list comes back empty. The thread id is already unique
    // per run (`wfrun:<runId>`), which is the real isolation boundary.
    for await (const snap of graph.getStateHistory({
      configurable: { thread_id: `wfrun:${runId}` },
    })) {
      const v = (snap.values ?? {}) as { stateLabel?: string; event?: ClientSeoBatchEvent | null; facts?: ClientSeoBatchFacts | null }
      steps.push({
        stateLabel: v.stateLabel ?? '',
        eventType: v.event?.type ?? null,
        currentIndex: v.facts?.currentIndex ?? null,
        checkpointId: (snap.config?.configurable as { checkpoint_id?: string } | undefined)?.checkpoint_id ?? null,
        createdAt: snap.createdAt ?? null,
      })
      if (steps.length >= limit) break
    }
    return steps
  } catch (err) {
    console.warn('[seo-batch-graph] history read failed open:', err instanceof Error ? err.message : err)
    return []
  }
}
