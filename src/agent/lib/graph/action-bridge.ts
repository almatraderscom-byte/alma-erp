/**
 * Roadmap 1 Phase 34 — the UNIVERSAL interrupt/ask/approval/resume bridge.
 *
 * Generalizes the LG-3 log_expense pilot into ONE typed contract every staged
 * decision uses: ask, approve, reject, revise, cancel, external handoff.
 *
 * Boundaries (roadmap invariants, unchanged from the pilot):
 *  - The interrupt is TRANSPORT, never authorization. Server-side guards in
 *    the routes (owner auth, status, expiry) remain the only authorization.
 *  - Approval authorizes exactly the DISPLAYED effect. Any revision of
 *    amount/audience/content/domain requires a NEW confirmation — the guard
 *    refuses approve-with-changes outright.
 *  - Binding is card → work run → graph thread → expected state version. A
 *    stale or mismatched version produces ZERO effects and a clear verdict.
 *  - Every path is idempotent: expiry, reject, revision, double click,
 *    reconnect, stale version, and already-executed all resolve to a typed
 *    verdict with no second effect.
 */
import { StateGraph, Annotation, START, END, interrupt, Command } from '@langchain/langgraph'
import type { BaseCheckpointSaver } from '@langchain/langgraph'
import { getGraphCheckpointer } from '@/agent/lib/graph/graph-checkpointer'

export const ACTION_BRIDGE_NS = 'action_bridge'

// ── The one typed payload/resume contract ────────────────────────────────────

export type BridgeDecision = 'ask_answer' | 'approve' | 'reject' | 'revise' | 'cancel' | 'external_handoff'

/** What a paused thread shows the outside world (the card, typed). */
export interface BridgeInterruptPayload {
  /** Card family: log_expense | fb_post | staff_dispatch | campaign_budget |
   *  browser_task | outbound_call | seo_fix | product_publish | image_gen | … */
  actionType: string
  cardKind: 'approval' | 'ask'
  cardId: string
  summary: string
  workflowRunId: string | null
  /** The run version the card was staged against — approve must match it. */
  expectedStateVersion: number | null
}

/** What a decision endpoint feeds back into the paused thread. */
export interface BridgeResumeValue {
  decision: BridgeDecision
  cardId: string
  /** ask_answer: the owner's answer · revise: the feedback text. */
  text?: string | null
  /** The run version the DECIDER read. Mismatch with the staged version → zero effects. */
  expectedStateVersion?: number | null
}

// ── Pure decision guard (used by routes + graph + tests) ─────────────────────

export type BridgeGuardVerdict =
  | 'ok'
  | 'already_resolved'
  | 'expired'
  | 'stale_version'
  | 'revision_requires_new_card'
  | 'wrong_card'

/**
 * The idempotency/authorization-shape guard every decision passes BEFORE any
 * effect. Pure — routes call it with live rows; tests enumerate the matrix.
 */
export function guardBridgeDecision(opts: {
  card: { id: string; status: string; expired?: boolean }
  resume: BridgeResumeValue
  /** Live run version when the card is bound to a run (null = unbound). */
  liveStateVersion?: number | null
  /** Version the card was STAGED against (payload.expectedStateVersion). */
  stagedStateVersion?: number | null
  /** True when the approve request carries modified effect fields. */
  hasRevisedFields?: boolean
}): BridgeGuardVerdict {
  const { card, resume } = opts
  if (resume.cardId !== card.id) return 'wrong_card'
  if (card.status !== 'pending') return 'already_resolved'
  if (card.expired) return 'expired'
  if (resume.decision === 'approve' && opts.hasRevisedFields) return 'revision_requires_new_card'
  if (
    resume.decision === 'approve'
    && opts.stagedStateVersion != null
    && opts.liveStateVersion != null
    && opts.stagedStateVersion !== opts.liveStateVersion
  ) {
    return 'stale_version'
  }
  return 'ok'
}

/** Bangla verdict line for the owner — clear message, zero effects. */
export function bridgeVerdictMessageBn(v: BridgeGuardVerdict): string {
  switch (v) {
    case 'ok': return ''
    case 'already_resolved': return 'এই কার্ডের সিদ্ধান্ত আগেই নেওয়া হয়ে গেছে — নতুন করে কিছু চালানো হয়নি।'
    case 'expired': return 'কার্ডটার মেয়াদ শেষ — কিছুই চালানো হয়নি; দরকার হলে নতুন কার্ড বানিয়ে দেবো।'
    case 'stale_version': return 'কাজটার অবস্থা এর মধ্যে বদলে গেছে — পুরনো কার্ড দিয়ে কিছু চালানো নিরাপদ নয়; নতুন কার্ড লাগবে।'
    case 'revision_requires_new_card': return 'বদল করা হয়েছে — বদলানো কাজ আগের অনুমোদনে চলে না; নতুন কার্ড approve করতে হবে।'
    case 'wrong_card': return 'এই সিদ্ধান্তটা অন্য কার্ডের — কিছুই চালানো হয়নি।'
  }
}

// ── The universal decision graph ─────────────────────────────────────────────

const BridgeState = Annotation.Root({
  payload: Annotation<BridgeInterruptPayload>,
  resume: Annotation<BridgeResumeValue | null>({ reducer: (_a, b) => b, default: () => null }),
  verdict: Annotation<BridgeGuardVerdict | null>({ reducer: (_a, b) => b, default: () => null }),
  applied: Annotation<boolean>({ reducer: (_a, b) => b, default: () => false }),
})

export function buildDecisionBridgeGraph(checkpointer: BaseCheckpointSaver) {
  return new StateGraph(BridgeState)
    .addNode('stage_decision', (s) => {
      const resume = interrupt<BridgeInterruptPayload, BridgeResumeValue>(s.payload)
      return { resume }
    })
    .addNode('apply_decision', (s) => {
      // The graph VALIDATES and RECORDS — the route executes (server-side
      // authorization stays where it is). `applied` flips exactly once; the
      // approved text can never be re-read as a new owner instruction because
      // the resume value is typed, not prose fed back into the model.
      if (!s.resume) return { verdict: 'wrong_card' as const, applied: false }
      const verdict = guardBridgeDecision({
        card: { id: s.payload.cardId, status: 'pending' },
        resume: s.resume,
        stagedStateVersion: s.payload.expectedStateVersion,
        liveStateVersion: s.resume.expectedStateVersion ?? null,
      })
      return { verdict, applied: verdict === 'ok' }
    })
    .addEdge(START, 'stage_decision')
    .addEdge('stage_decision', 'apply_decision')
    .addEdge('apply_decision', END)
    .compile({ checkpointer })
}

// ── Stage / resume helpers ───────────────────────────────────────────────────

/** Namespace lives INSIDE the thread id (`action_bridge:<cardId>`): custom
 * `checkpoint_ns` values desync getState/next on the JS savers (verified
 * against MemorySaver), and a prefixed thread id gives the same isolation. */
export function bridgeThreadIdFor(cardId: string): string {
  return `${ACTION_BRIDGE_NS}:${cardId}`
}

function bridgeConfigFor(cardId: string) {
  return {
    configurable: { thread_id: bridgeThreadIdFor(cardId) },
    durability: 'sync' as const,
  }
}

export interface StageBridgeResult {
  staged: boolean
  threadId: string | null
  error: string | null
}

/**
 * Park a typed decision thread for a card. Fail-open ({staged:false}) — a
 * card without a thread still works through the legacy route path.
 */
export async function stageDecisionThread(
  payload: BridgeInterruptPayload,
  opts: { turnId?: string | null; checkpointer?: BaseCheckpointSaver | null } = {},
): Promise<StageBridgeResult> {
  try {
    const checkpointer = opts.checkpointer ?? getGraphCheckpointer()
    if (!checkpointer) return { staged: false, threadId: null, error: 'no_checkpointer' }
    const graph = buildDecisionBridgeGraph(checkpointer)
    const threadId = bridgeThreadIdFor(payload.cardId)
    const cfg = bridgeConfigFor(payload.cardId)
    const out = await graph.invoke({ payload }, cfg)
    const interrupted = Array.isArray((out as Record<string, unknown>).__interrupt__)
      && ((out as Record<string, unknown>).__interrupt__ as unknown[]).length > 0
    if (!interrupted) return { staged: false, threadId: null, error: 'graph_did_not_interrupt' }
    return { staged: true, threadId, error: null }
  } catch (err) {
    return { staged: false, threadId: null, error: err instanceof Error ? err.message : String(err) }
  }
}

export interface ResumeBridgeResult {
  resumed: boolean
  /** True the FIRST time only — a second resume of the same thread reports
   *  alreadyConsumed and applies nothing (double click / reconnect safety). */
  applied: boolean
  alreadyConsumed: boolean
  verdict: BridgeGuardVerdict | null
  error: string | null
}

/**
 * Feed the owner's typed decision into the paused thread. Idempotent: a
 * consumed thread never applies twice; an unknown/dead thread reports
 * resumed:false so the route can fall back to its legacy path.
 */
export async function resumeDecisionThread(
  resume: BridgeResumeValue,
  opts: { checkpointer?: BaseCheckpointSaver | null } = {},
): Promise<ResumeBridgeResult> {
  const fail = (error: string): ResumeBridgeResult => ({ resumed: false, applied: false, alreadyConsumed: false, verdict: null, error })
  try {
    const checkpointer = opts.checkpointer ?? getGraphCheckpointer()
    if (!checkpointer) return fail('no_checkpointer')
    const graph = buildDecisionBridgeGraph(checkpointer)
    const cfg = bridgeConfigFor(resume.cardId)
    // Reconnect/double-click safety: a thread whose interrupt was already
    // consumed has no next step — report alreadyConsumed instead of re-running.
    const state = await graph.getState(cfg)
    if (!state || (state.next ?? []).length === 0) {
      const prior = (state?.values ?? {}) as { applied?: boolean; verdict?: BridgeGuardVerdict | null }
      return {
        resumed: Boolean(state),
        applied: false,
        alreadyConsumed: Boolean(state),
        verdict: prior.verdict ?? null,
        error: state ? null : 'thread_not_found',
      }
    }
    const out = await graph.invoke(new Command({ resume }), cfg)
    const s = out as { applied?: boolean; verdict?: BridgeGuardVerdict | null }
    return { resumed: true, applied: s.applied === true, alreadyConsumed: false, verdict: s.verdict ?? null, error: null }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
}
