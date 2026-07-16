/**
 * Phase 47 — the SEO/CRO release loop:
 *
 *   draft → approved → preview_verified → released (owner merge) → measured
 *                                       ↘ rolled_back
 *
 * Hard rules:
 * - The agent NEVER edits/deploys production. `released` is something the
 *   OWNER does (merge); this module only validates and tracks state.
 * - Every change in a release carries evidence, affected URLs, validation
 *   method and rollback — otherwise the plan is invalid.
 * - Recommendations may never contain a ranking guarantee.
 * - Durable `seo_release:<id>` thread mirrors transitions (fail-open).
 */
import { StateGraph, Annotation, START, END } from '@langchain/langgraph'
import { getGraphCheckpointer, checkpointConfigFor } from '@/agent/lib/graph/graph-checkpointer'
import { isWorkflowGraphEnabled } from '@/agent/lib/graph/seo-batch-graph'
import { containsRankingGuarantee } from '@/agent/lib/seo/technical-audit'

export const SEO_RELEASE_NS = 'seo_release'

export type ReleaseStatus = 'draft' | 'approved' | 'preview_verified' | 'released' | 'rolled_back'

export interface ReleaseChange {
  description: string
  affectedUrls: string[]
  evidence: string
  validation: string
  rollback: string
}

export interface SeoReleasePlan {
  id: string
  title: string
  changes: ReleaseChange[]
  status: ReleaseStatus
  /** Who moved it to released — must be the owner, never the agent. */
  releasedBy?: string
}

/** Legal state transitions — anything else is a protocol violation. */
export const RELEASE_TRANSITIONS: Record<ReleaseStatus, ReleaseStatus[]> = {
  draft: ['approved'],
  approved: ['preview_verified', 'draft'],
  preview_verified: ['released', 'draft'],
  released: ['rolled_back'],
  rolled_back: ['draft'],
}

export function canTransition(from: ReleaseStatus, to: ReleaseStatus): boolean {
  return RELEASE_TRANSITIONS[from]?.includes(to) ?? false
}

export interface ReleaseValidation {
  ok: boolean
  errors: string[]
}

/** A release plan is only as good as its weakest change. */
export function validateReleasePlan(plan: Pick<SeoReleasePlan, 'title' | 'changes'>): ReleaseValidation {
  const errors: string[] = []
  if (!plan.title?.trim()) errors.push('title required')
  if (!plan.changes || plan.changes.length === 0) errors.push('at least one change required')
  for (const [i, c] of (plan.changes ?? []).entries()) {
    if (!c.description?.trim()) errors.push(`change[${i}]: description required`)
    if (!c.affectedUrls || c.affectedUrls.length === 0) errors.push(`change[${i}]: affectedUrls required`)
    if (!c.evidence?.trim()) errors.push(`change[${i}]: evidence required — no evidence, no change`)
    if (!c.validation?.trim()) errors.push(`change[${i}]: validation method required`)
    if (!c.rollback?.trim()) errors.push(`change[${i}]: rollback required`)
    const text = `${c.description} ${c.evidence}`
    if (containsRankingGuarantee(text)) errors.push(`change[${i}]: ranking guarantees are forbidden`)
  }
  return { ok: errors.length === 0, errors }
}

export interface TransitionResult {
  ok: boolean
  status: ReleaseStatus
  error?: string
}

/**
 * Apply a transition with the guard rails:
 * - released requires preview_verified AND an owner actor;
 * - approved requires a valid plan.
 */
export function applyTransition(
  plan: SeoReleasePlan,
  to: ReleaseStatus,
  actor: 'agent' | 'owner',
): TransitionResult {
  if (!canTransition(plan.status, to)) {
    return { ok: false, status: plan.status, error: `illegal transition ${plan.status} → ${to}` }
  }
  if (to === 'approved') {
    const v = validateReleasePlan(plan)
    if (!v.ok) return { ok: false, status: plan.status, error: `plan invalid: ${v.errors.join('; ')}` }
  }
  if (to === 'released' && actor !== 'owner') {
    return { ok: false, status: plan.status, error: 'only the OWNER releases to production — the agent never deploys' }
  }
  return { ok: true, status: to }
}

// ---------------------------------------------------------------------------
// Durable thread mirror (fail-open)
// ---------------------------------------------------------------------------

export interface ReleaseEvent {
  releaseId: string
  from: ReleaseStatus
  to: ReleaseStatus
  actor: string
  eventNo?: number
}

const ReleaseState = Annotation.Root({
  event: Annotation<ReleaseEvent | null>({ reducer: (_a, b) => b, default: () => null }),
  eventCount: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
})

function buildGraph(checkpointer: NonNullable<ReturnType<typeof getGraphCheckpointer>>) {
  return new StateGraph(ReleaseState)
    .addNode('apply_event', (s) => ({
      eventCount: 1,
      event: s.event ? { ...s.event, eventNo: s.eventCount + 1 } : null,
    }))
    .addEdge(START, 'apply_event')
    .addEdge('apply_event', END)
    .compile({ checkpointer })
}

/** Mirror one release transition onto seo_release:<id>. Fail-open. */
export async function mirrorReleaseEvent(event: ReleaseEvent): Promise<void> {
  try {
    if (!isWorkflowGraphEnabled()) return
    const checkpointer = getGraphCheckpointer()
    if (!checkpointer) return
    await buildGraph(checkpointer).invoke(
      { event },
      checkpointConfigFor({ conversationId: `seo_release:${event.releaseId}`, turnId: null, namespace: SEO_RELEASE_NS }),
    )
  } catch (err) {
    console.warn('[seo-release-graph] mirror failed open:', err instanceof Error ? err.message : err)
  }
}
