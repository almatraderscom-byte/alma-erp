/**
 * Roadmap 1 Phase 35 — per-invocation specialist subgraphs with LangGraph
 * `Send` fan-out for INDEPENDENT READ/RESEARCH branches only.
 *
 * Contract (roadmap):
 *  - Workers are stateless: each branch gets a SELF-CONTAINED brief and
 *    returns structured findings (findings, evidence, uncertainty, artifacts,
 *    proposed next step) — never a conversation handle.
 *  - Parallel branches are READ-ONLY by construction (`readOnly: true` rides
 *    every fan-out brief into runSubAgent's tool filter): they cannot write
 *    memory or owner-facing effects. Writes stay sequential behind the
 *    safety kernel (approval cards / action bridge).
 *  - A failed specialist stays VISIBLE (success:false finding) and never
 *    erases sibling evidence — the reconcile node keeps every branch.
 *  - Cache policy applies ONLY to briefs explicitly marked cacheable with an
 *    invalidation/version key (pure, stable reads) — stored in the LangGraph
 *    BaseStore under the `specialist_cache` namespace, fail-open.
 *  - The HEAD reconciles conflicts and writes the single owner-facing reply;
 *    this module returns structured material, never prose to the owner.
 */
import { StateGraph, Annotation, START, END, Send } from '@langchain/langgraph'
import type { SpecialistRole } from '@/agent/lib/models/specialist-roles'
import { getAlmaMemoryStore } from '@/agent/lib/graph/memory-store'

export const SPECIALIST_FANOUT_MAX_BRANCHES = 4
export const SPECIALIST_CACHE_NS = 'specialist_cache'

export interface SpecialistBrief {
  role: SpecialistRole
  /** Self-contained task text — everything the stateless worker needs. */
  task: string
  businessId: string
  conversationId?: string | null
  /** Pure, stable reads may opt into the cache with an explicit key+version. */
  cacheable?: boolean
  cacheKey?: string
  cacheVersion?: string
}

export interface SpecialistFinding {
  role: SpecialistRole
  success: boolean
  /** The worker's structured return — findings first, never owner prose. */
  findings: string
  evidence: string[]
  uncertainty: string
  artifacts: string[]
  proposedNextStep: string | null
  toolsUsed: string[]
  costUsd: number
  fromCache: boolean
  error: string | null
}

export interface ReconciledFindings {
  findings: SpecialistFinding[]
  succeeded: number
  failed: number
  /** Role pairs whose findings look contradictory — the head must resolve. */
  conflicts: Array<{ roles: [string, string]; note: string }>
  /** Compact structured block the head reads to write ONE grounded reply. */
  headBrief: string
}

/** The injected executor — production wires runSubAgent; tests wire fakes. */
export type SpecialistRunner = (brief: SpecialistBrief & { readOnly: true }) => Promise<{
  success: boolean
  summary: string
  toolsUsed: string[]
  costUsd: number
  error?: string
}>

// ── Reconciliation (pure) ────────────────────────────────────────────────────

const NEGATION_HINT_RE = /(না|nei|নেই|kome|কমে|loss|লস|খারাপ|falls?|drop)/i
const POSITIVE_HINT_RE = /(বেড়ে|bere|barche|growth|profit|লাভ|ভালো|valo|rise)/i

export function reconcileFindings(findings: SpecialistFinding[]): ReconciledFindings {
  const ok = findings.filter((f) => f.success)
  const conflicts: ReconciledFindings['conflicts'] = []
  // Deterministic first-pass conflict flag: one branch reads positive where a
  // sibling reads negative on overlapping text. The HEAD judges — this only
  // guarantees a disagreement can't be silently averaged away.
  for (let i = 0; i < ok.length; i++) {
    for (let j = i + 1; j < ok.length; j++) {
      const a = ok[i], b = ok[j]
      if (
        (POSITIVE_HINT_RE.test(a.findings) && NEGATION_HINT_RE.test(b.findings))
        || (NEGATION_HINT_RE.test(a.findings) && POSITIVE_HINT_RE.test(b.findings))
      ) {
        conflicts.push({ roles: [a.role, b.role], note: 'বিপরীতমুখী ইঙ্গিত — মাথাকে মিলিয়ে রায় দিতে হবে' })
      }
    }
  }
  const lines: string[] = []
  for (const f of findings) {
    lines.push(
      f.success
        ? `• [${f.role}] ${f.findings.slice(0, 300)}${f.uncertainty ? ` (অনিশ্চয়তা: ${f.uncertainty.slice(0, 80)})` : ''}${f.proposedNextStep ? ` → প্রস্তাব: ${f.proposedNextStep.slice(0, 80)}` : ''}`
        : `• [${f.role}] ব্যর্থ (${f.error ?? 'unknown'}) — এই শাখার তথ্য নেই, বাকিদের প্রমাণ অটুট`,
    )
  }
  for (const c of conflicts) lines.push(`⚠ দ্বন্দ্ব: ${c.roles.join(' vs ')} — ${c.note}`)
  return {
    findings,
    succeeded: ok.length,
    failed: findings.length - ok.length,
    conflicts,
    headBrief: `[SPECIALIST FAN-OUT ফলাফল — head একমাত্র উত্তরদাতা]\n${lines.join('\n')}`,
  }
}

// ── The fan-out graph ────────────────────────────────────────────────────────

const S = Annotation.Root({
  briefs: Annotation<SpecialistBrief[]>,
  /** Per-branch Send payload. */
  brief: Annotation<SpecialistBrief | null>({ reducer: (_a, b) => b, default: () => null }),
  findings: Annotation<SpecialistFinding[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
  reconciled: Annotation<ReconciledFindings | null>({ reducer: (_a, b) => b, default: () => null }),
})

async function cacheGet(brief: SpecialistBrief): Promise<SpecialistFinding | null> {
  if (!brief.cacheable || !brief.cacheKey || !brief.cacheVersion) return null
  try {
    const store = getAlmaMemoryStore()
    if (!store) return null
    const item = await store.get([SPECIALIST_CACHE_NS, brief.role], `${brief.cacheKey}@${brief.cacheVersion}`)
    const v = item?.value as { finding?: SpecialistFinding } | undefined
    return v?.finding ? { ...v.finding, fromCache: true } : null
  } catch { return null }
}

async function cachePut(brief: SpecialistBrief, finding: SpecialistFinding): Promise<void> {
  if (!brief.cacheable || !brief.cacheKey || !brief.cacheVersion || !finding.success) return
  try {
    const store = getAlmaMemoryStore()
    if (!store) return
    await store.put([SPECIALIST_CACHE_NS, brief.role], `${brief.cacheKey}@${brief.cacheVersion}`, { finding })
  } catch { /* cache is an upgrade, never a dependency */ }
}

export function buildSpecialistFanoutGraph(runner: SpecialistRunner) {
  return new StateGraph(S)
    .addNode('plan_fanout', (s) => {
      // Cap + read-only reads happen at dispatch: every Send carries ONE brief.
      const capped = s.briefs.slice(0, SPECIALIST_FANOUT_MAX_BRANCHES)
      if (capped.length < s.briefs.length) {
        console.warn(`[specialist-fanout] capped ${s.briefs.length} → ${capped.length} branches`)
      }
      return { briefs: capped }
    })
    .addNode('run_specialist', async (s) => {
      const brief = s.brief!
      const cached = await cacheGet(brief)
      if (cached) return { findings: [cached] }
      try {
        const r = await runner({ ...brief, readOnly: true })
        const finding: SpecialistFinding = {
          role: brief.role,
          success: r.success,
          findings: r.summary,
          evidence: r.toolsUsed.map((t) => `tool:${t}`),
          uncertainty: r.success ? '' : 'শাখা ব্যর্থ — তথ্য অনুপস্থিত',
          artifacts: [],
          proposedNextStep: null,
          toolsUsed: r.toolsUsed,
          costUsd: r.costUsd,
          fromCache: false,
          error: r.success ? null : (r.error ?? 'unknown'),
        }
        await cachePut(brief, finding)
        return { findings: [finding] }
      } catch (err) {
        // Failure isolation: the branch is VISIBLE as failed; siblings keep
        // their evidence (append reducer — nothing is overwritten).
        return {
          findings: [{
            role: brief.role, success: false, findings: '', evidence: [], uncertainty: 'শাখা ব্যর্থ',
            artifacts: [], proposedNextStep: null, toolsUsed: [], costUsd: 0, fromCache: false,
            error: err instanceof Error ? err.message : String(err),
          } satisfies SpecialistFinding],
        }
      }
    })
    .addNode('reconcile', (s) => ({ reconciled: reconcileFindings(s.findings) }))
    .addEdge(START, 'plan_fanout')
    .addConditionalEdges(
      'plan_fanout',
      (s) => (s.briefs.length === 0 ? ['reconcile'] : s.briefs.map((b) => new Send('run_specialist', { brief: b }))),
      ['run_specialist', 'reconcile'],
    )
    .addEdge('run_specialist', 'reconcile')
    .addEdge('reconcile', END)
    .compile()
}

/**
 * Run independent read/research briefs in parallel and reconcile. The default
 * runner is the real runSubAgent (readOnly enforced); the head consumes
 * `reconciled.headBrief` and writes the ONE owner-facing Bangla answer.
 */
export async function runSpecialistFanout(
  briefs: SpecialistBrief[],
  opts: { runner?: SpecialistRunner } = {},
): Promise<ReconciledFindings> {
  const runner: SpecialistRunner =
    opts.runner
    ?? (async (brief) => {
      const { runSubAgent } = await import('@/agent/lib/models/subagent')
      const r = await runSubAgent({
        role: brief.role,
        task: brief.task,
        businessId: brief.businessId as never,
        conversationId: brief.conversationId ?? undefined,
        readOnly: true,
      })
      return { success: r.success, summary: r.summary, toolsUsed: r.toolsUsed, costUsd: r.costUsd, error: r.error }
    })
  const graph = buildSpecialistFanoutGraph(runner)
  const out = await graph.invoke({ briefs }, { recursionLimit: 24 })
  return out.reconciled ?? reconcileFindings([])
}
