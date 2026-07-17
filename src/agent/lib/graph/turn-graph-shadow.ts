/**
 * LG-4 — the head turn as an explicit graph, SHADOW MODE
 * (docs/langgraph-adoption-roadmap.md: "graph decides, legacy executes,
 * decisions logged" → canary → on; mirrors the state-router Phase 7 rollout).
 *
 * This slice models the turn's DECISION pipeline as a StateGraph:
 *
 *   guard (pure fast-path re-derivation) → tier_check (compare vs the live
 *   HeadDecision) → tools_snapshot (record what the router gave the head) →
 *   loop_plan (record the loop caps the legacy turn will run with)
 *
 * It runs on EVERY gated turn with ZERO extra model/tool/DB calls — every
 * node is pure over inputs the legacy path already computed — and its record
 * lands on the route span (`extras.turnGraph`), so before any cutover we can
 * measure on real traffic: does the graph's guard topology reproduce the
 * legacy router's decisions? Hard agreement is only scored where the
 * re-derivation is deterministic (deny/call fast-paths and an explicit pin);
 * hint/DB-dependent kinds (personal, continuation) are recorded, not judged.
 *
 * Fail-open: any failure returns null and the turn proceeds untouched.
 * Gate: AGENT_LANGGRAPH_TURN — 'false' kill switch; 'shadow'/'true' force-on;
 * unset → ON in Vercel preview, OFF in production.
 */
import { StateGraph, Annotation, START, END } from '@langchain/langgraph'
import { classifyHeadFastPath, type HeadFastPathKind, type HeadTier } from '@/agent/lib/models/head-router'
import {
  runOwnerTurnGraphShadow,
  type OwnerTurnGraphResult,
  type OwnerTurnStateLoader,
} from '@/agent/lib/graph/owner-turn-graph'

export function isTurnGraphShadowEnabled(
  flag = process.env.AGENT_LANGGRAPH_TURN,
  vercelEnv = process.env.VERCEL_ENV,
): boolean {
  if (flag === 'false') return false
  if (flag === 'shadow' || flag === 'true') return true
  return vercelEnv === 'preview'
}

export interface TurnGraphShadowInput {
  lastUserText: string
  /** The LIVE head decision the turn is actually running with. */
  headTier: HeadTier
  headVia: string
  listenMode: boolean
  /** What the tool router actually gave the head. */
  toolGroups: readonly string[]
  toolCount: number
  toolRouter?: string | null
  /** The loop cap the legacy turn will run with. */
  maxIterations: number
  // ── Phase 33: inputs for the FULL owner-turn graph (optional — absent on
  // callers that only want the LG-4 fast-path shadow, e.g. old tests). ──
  conversationId?: string
  turnId?: string | null
  businessId?: string
  boundToolName?: string | null
  /** The live continuity resolver's binding (null when it didn't run). */
  continuityBinding?: string | null
  allowMutations?: boolean
  /** Reuses the turn's already-loaded durable state — zero extra DB calls. */
  loadState?: OwnerTurnStateLoader
}

export interface TurnGraphShadowRecord {
  mode: 'shadow'
  /** The graph's own pure fast-path verdict. */
  fastPath: HeadFastPathKind
  /** null = not scoreable (hint/DB-dependent/triage kind); boolean = scored. */
  agree: boolean | null
  legacyVia: string
  legacyTier: HeadTier
  toolGroups: string[]
  toolCount: number
  maxIterations: number
  /** Phase 33: the full 12-node graph's trace + agreement (when inputs allow). */
  graph?: {
    trace: OwnerTurnGraphResult['trace']
    agreement: OwnerTurnGraphResult['agreement']
  }
}

const ShadowState = Annotation.Root({
  input: Annotation<TurnGraphShadowInput>,
  fastPath: Annotation<HeadFastPathKind>({ reducer: (_a, b) => b, default: () => null }),
  agree: Annotation<boolean | null>({ reducer: (_a, b) => b, default: () => null }),
})

/**
 * Which live `via` values each scoreable fast-path kind must map to. Only the
 * deterministic kinds are scored: deny/call are pure regex on both sides;
 * marketing/routine are pure too BUT owner kill-switches (ENABLE_CHEAP_HEAD /
 * ENABLE_MARKETING_HEAD) can legitimately turn them off live, so those score
 * as agreement when EITHER the fast-path via matches OR a deliberate
 * owner-config redirect is in play (via prefix check keeps it honest).
 */
function scoreAgreement(kind: HeadFastPathKind, via: string, tier: HeadTier): boolean | null {
  if (tier === 'explicit' || via.startsWith('explicit') || via.startsWith('anthropic_down_explicit')) {
    // Pinned model — the router never consulted the fast paths; nothing to score.
    return null
  }
  switch (kind) {
    case 'deny_kw':
      return via.startsWith('deny_kw')
    case 'call_intent':
      return via.startsWith('call_intent')
    case 'marketing_kw':
      return via.startsWith('marketing_kw') || via.startsWith('explicit_marketing')
    case 'routine_kw':
      return via.startsWith('routine_kw')
    // Hint / DB-dependent kinds and "no fast path" (triage/sticky territory):
    // recorded for the dashboard, never judged.
    default:
      return null
  }
}

const shadowGraph = new StateGraph(ShadowState)
  .addNode('guard', (s) => ({ fastPath: classifyHeadFastPath(s.input.lastUserText) }))
  .addNode('tier_check', (s) => ({ agree: scoreAgreement(s.fastPath, s.input.headVia, s.input.headTier) }))
  // Pass-through nodes: they exist so the SHAPE of the future live turn graph
  // (guard → tier → tools → loop plan) is what shadow traffic exercises — the
  // topology is the thing being validated, not the values (already computed).
  .addNode('tools_snapshot', () => ({}))
  .addNode('loop_plan', () => ({}))
  .addEdge(START, 'guard')
  .addEdge('guard', 'tier_check')
  .addEdge('tier_check', 'tools_snapshot')
  .addEdge('tools_snapshot', 'loop_plan')
  .addEdge('loop_plan', END)
  .compile()

/**
 * Run the shadow decision graph for one turn. Pure + fast (<1ms) + fail-open:
 * returns null on any failure or when gated off; the live turn never depends
 * on it.
 */
export async function runTurnGraphShadow(
  input: TurnGraphShadowInput,
): Promise<TurnGraphShadowRecord | null> {
  try {
    if (!isTurnGraphShadowEnabled()) return null
    const s = await shadowGraph.invoke({ input }, { recursionLimit: 8 })
    const record: TurnGraphShadowRecord = {
      mode: 'shadow',
      fastPath: s.fastPath,
      agree: s.agree,
      legacyVia: input.headVia,
      legacyTier: input.headTier,
      toolGroups: [...input.toolGroups],
      toolCount: input.toolCount,
      maxIterations: input.maxIterations,
    }
    // Phase 33: when the caller supplies the full-turn inputs, run the REAL
    // 12-node owner-turn graph in shadow and attach its trace + agreement.
    // Fail-open inside; the LG-4 record above stands regardless.
    if (input.conversationId && input.loadState) {
      const full = await runOwnerTurnGraphShadow(
        {
          conversationId: input.conversationId,
          turnId: input.turnId ?? null,
          businessId: input.businessId ?? 'ALMA_LIFESTYLE',
          text: input.lastUserText,
          listenMode: input.listenMode,
          legacy: {
            headTier: input.headTier,
            headVia: input.headVia,
            toolGroups: input.toolGroups,
            boundToolName: input.boundToolName ?? null,
            allowMutations: input.allowMutations ?? false,
            continuityBinding: input.continuityBinding ?? null,
            maxIterations: input.maxIterations,
          },
        },
        input.loadState,
      )
      if (full) {
        record.graph = { trace: full.trace, agreement: full.agreement }
        if (full.agreement.agree === false) {
          console.warn(
            `[owner-turn-graph] SHADOW DISAGREEMENT ${full.agreement.disagreements.join(',')} conv=${input.conversationId} textLen=${input.lastUserText.length}`,
          )
        }
      }
    }
    // One line per DISAGREEMENT only — agreements are the overwhelming norm
    // and live in the route span; a mismatch is what needs eyes.
    if (record.agree === false) {
      console.warn(
        `[turn-graph-shadow] MISMATCH fastPath=${record.fastPath} legacyVia=${record.legacyVia} tier=${record.legacyTier} textLen=${input.lastUserText.length}`,
      )
    }
    return record
  } catch (err) {
    console.warn('[turn-graph-shadow] failed open:', err instanceof Error ? err.message : err)
    return null
  }
}
