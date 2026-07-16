/**
 * LG-6 slice 2 — TEMPLATE workflow runs (content pipeline first) get a durable
 * graph thread, mirrored from the canonical transition choke point.
 *
 * Slice 1 mirrored the client SEO batch's bespoke reducer. This slice hooks
 * `transitionWorkflowRun` itself — the single place EVERY template run
 * (product_post draft→image→preview→post→verify, ad_campaign, …) changes
 * state — so one mirror covers the whole roadmap list of business workflows:
 *
 *   thread_id `wfstep:<runId>` · one `apply_transition` super-step per event
 *   (distinct from slice 1's `wfrun:<runId>` threads — checkpoints all live in
 *   the root ns, so the THREAD ID is the isolation boundary)
 *
 * The graph re-checks each transition against the template's own step map
 * (`steps[from].next`) — the same legality data the legacy engine consults —
 * and records `legal:false` instead of blocking when a transition steps
 * outside it (cards can legally jump: rejected → back to draft). That gives
 * the LG-4-style drift/anomaly signal for free.
 *
 * Discipline (same as every LG slice): fail-open — any checkpointer problem
 * logs one line and the legacy WorkflowRun flow proceeds untouched.
 * Gate: AGENT_LANGGRAPH_WORKFLOW (shared with slice 1) — 'false' kill switch,
 * 'true' force-on, default ON in Vercel preview / OFF in production.
 */
import { StateGraph, Annotation, START, END } from '@langchain/langgraph'
import { getWorkflowTemplate, getTemplateStep } from '@/agent/lib/workflow-templates'
import { getGraphCheckpointer, checkpointConfigFor } from '@/agent/lib/graph/graph-checkpointer'
import { isWorkflowGraphEnabled } from '@/agent/lib/graph/seo-batch-graph'

export const WORKFLOW_RUN_NS = 'workflow_run'

export interface WorkflowRunGraphEvent {
  fromStatus: string
  toStatus: string
  fromState: string
  toState: string
  cause: string
  stateVersion: number
}

const WorkflowRunState = Annotation.Root({
  kind: Annotation<string>({ reducer: (_a, b) => b, default: () => '' }),
  status: Annotation<string>({ reducer: (_a, b) => b, default: () => '' }),
  state: Annotation<string>({ reducer: (_a, b) => b, default: () => '' }),
  event: Annotation<WorkflowRunGraphEvent | null>({ reducer: (_a, b) => b, default: () => null }),
  /** Transition allowed by the template's step map (informational, never blocking). */
  legal: Annotation<boolean>({ reducer: (_a, b) => b, default: () => true }),
  /** Owner-readable Bangla step label from the template. */
  labelBn: Annotation<string>({ reducer: (_a, b) => b, default: () => '' }),
  // Post-node checkpoint marker (2026-07-16 dedupe fix) — see live-browser-graph.
  stepCount: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
  appliedStep: Annotation<number>({ reducer: (_a, b) => b, default: () => -1 }),
})

function isTemplateLegal(kind: string, fromState: string, toState: string): boolean {
  const template = getWorkflowTemplate(kind)
  if (!template) return true // non-template runs have no step map to violate
  if (fromState === toState) return true
  const from = getTemplateStep(kind, fromState)
  if (!from) return true // unknown FROM step — nothing to check against
  return from.next.includes(toState)
}

function buildGraph(checkpointer: NonNullable<ReturnType<typeof getGraphCheckpointer>>) {
  return new StateGraph(WorkflowRunState)
    .addNode('apply_transition', (s) => {
      const e = s.event
      const state = e ? e.toState : s.state
      const status = e ? e.toStatus : s.status
      const legal = e ? isTemplateLegal(s.kind, e.fromState, e.toState) : true
      const step = getTemplateStep(s.kind, state)
      return { state, status, legal, labelBn: step?.labelBn ?? '', stepCount: 1, appliedStep: s.stepCount + 1 }
    })
    .addEdge(START, 'apply_transition')
    .addEdge('apply_transition', END)
    .compile({ checkpointer })
}

function threadConfig(runId: string) {
  return checkpointConfigFor({ conversationId: `wfstep:${runId}`, turnId: null, namespace: WORKFLOW_RUN_NS })
}

/**
 * Mirror one WorkflowRun transition (or seed with event=null) into the run's
 * graph thread. Fail-open: null when gated off / checkpointer down / thrown.
 */
export async function mirrorWorkflowRunTransition(opts: {
  runId: string
  kind: string
  status: string
  state: string
  event: WorkflowRunGraphEvent | null
}): Promise<{ legal: boolean } | null> {
  try {
    if (!isWorkflowGraphEnabled()) return null
    const checkpointer = getGraphCheckpointer()
    if (!checkpointer) return null
    const graph = buildGraph(checkpointer)
    const out = await graph.invoke(
      { kind: opts.kind, status: opts.status, state: opts.state, event: opts.event },
      threadConfig(opts.runId),
    )
    const legal = (out as { legal?: boolean }).legal !== false
    if (!legal) {
      // Not an error — cards legitimately jump steps on rejection — but every
      // off-map transition is exactly what to eyeball before any cutover.
      console.warn(
        `[workflow-run-graph] OFF-MAP run=${opts.runId} kind=${opts.kind} ` +
          `${opts.event?.fromState}→${opts.event?.toState} cause=${opts.event?.cause}`,
      )
    } else {
      console.log(
        `[workflow-run-graph] run=${opts.runId} kind=${opts.kind} step=${opts.event?.toState ?? 'seed'} cause=${opts.event?.cause ?? 'seed'}`,
      )
    }
    return { legal }
  } catch (err) {
    console.warn('[workflow-run-graph] mirror failed open:', err instanceof Error ? err.message : err)
    return null
  }
}

export interface WorkflowRunHistoryStep {
  state: string
  status: string
  labelBn: string
  cause: string | null
  legal: boolean
  checkpointId: string | null
  createdAt: string | null
}

/**
 * The run's step-by-step history, newest first, straight from the thread's
 * checkpoint chain. Fail-open: [] when gated off / no thread / any error.
 */
export async function getWorkflowRunGraphHistory(runId: string, limit = 50): Promise<WorkflowRunHistoryStep[]> {
  try {
    if (!isWorkflowGraphEnabled()) return []
    const checkpointer = getGraphCheckpointer()
    if (!checkpointer) return []
    const graph = buildGraph(checkpointer)
    const steps: WorkflowRunHistoryStep[] = []
    for await (const snap of graph.getStateHistory({
      configurable: { thread_id: `wfstep:${runId}` },
    })) {
      const v = (snap.values ?? {}) as {
        state?: string; status?: string; labelBn?: string; legal?: boolean; event?: WorkflowRunGraphEvent | null
        stepCount?: number; appliedStep?: number
      }
      // Post-node checkpoints only (see live-browser-graph) — unstamped
      // pre-fix checkpoints pass through for old threads.
      const stamped = typeof v.appliedStep === 'number' && v.appliedStep >= 0
      if (stamped && ((snap.metadata as { source?: string } | undefined)?.source !== 'loop' || v.appliedStep !== v.stepCount)) continue
      steps.push({
        state: v.state ?? '',
        status: v.status ?? '',
        labelBn: v.labelBn ?? '',
        cause: v.event?.cause ?? null,
        legal: v.legal !== false,
        checkpointId: (snap.config?.configurable as { checkpoint_id?: string } | undefined)?.checkpoint_id ?? null,
        createdAt: snap.createdAt ?? null,
      })
      if (steps.length >= limit) break
    }
    return steps
  } catch (err) {
    console.warn('[workflow-run-graph] history read failed open:', err instanceof Error ? err.message : err)
    return []
  }
}
