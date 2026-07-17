/**
 * Roadmap 1 Phase 33 — the owner turn as a REAL LangGraph (SHADOW executor).
 *
 * Replaces the LG-4 no-op pass-through nodes with the roadmap's full 12-node
 * decision topology. The graph DECIDES with the same real functions production
 * uses (continuity resolver, fast-path classifier, pack assembly, mutation
 * guard, loop caps); the LEGACY path still EXECUTES — node 7 predicts effects,
 * it never performs them, so shadow traffic can never double-execute.
 *
 *   1 load_context        — identity + durable state (loader injected; the one
 *                           external call, isolated + idempotent)
 *   2 classify_intent     — fast path + continuity binding (focus transition)
 *   3 policy_precheck     — deny/call/listen + mutation authorization
 *   4 select_tool_pack    — bounded pack assembly (HEAD_TOOL_HARD_LIMIT)
 *   5 plan_model_call     — deterministic tool plan (routine read / bound step
 *                           / model-choice)
 *   6 tool_pre_guard      — universal pre-guard: listen strips tools, writes
 *                           need authorization, unknown tools are refused
 *   7 execute_or_stage    — SHADOW: predicted effect only (read | stage | none)
 *   8 observe_verify      — the verification contract the effect would need
 *   9 repair_retry        — hard loop caps (records, never loops in shadow)
 *  10 update_focus        — the WOULD-BE focus/checkpoint update; fail-CLOSED
 *                           rule: a write-state update that cannot be recorded
 *                           must abort the write, never proceed silently
 *  11 style_reply         — owner-reply mode (listen | status | work)
 *  12 persist_trace       — trace (focus/tool/guard/verification/final state —
 *                           all five, 100%) + agreement vs the live legacy turn
 *
 * State writes that could cause effects use sync durability via the shared
 * Postgres checkpointer when enabled; tests use MemorySaver and prove restart
 * -resume between every adjacent node pair.
 */
import { StateGraph, Annotation, START, END, MemorySaver } from '@langchain/langgraph'
import type { BaseCheckpointSaver } from '@langchain/langgraph'
import { classifyHeadFastPath, type HeadFastPathKind, type HeadTier } from '@/agent/lib/models/head-router'
import {
  resolveContinuityDecision,
  type ContinuityDecision,
  type FocusLite,
} from '@/agent/lib/continuity-resolver'
import { matchIntentPacks, packsForPendingActionType, packsForCheckpointTaskType, assemblePack, HEAD_TOOL_HARD_LIMIT, type PackKey } from '@/agent/tools/state-router'
import { detectRoutineIntent, routineIntentCall } from '@/agent/lib/graph/routine-turn-graph'
import { getGraphCheckpointer } from '@/agent/lib/graph/graph-checkpointer'

export const OWNER_TURN_GRAPH_NODES = [
  'load_context',
  'classify_intent',
  'policy_precheck',
  'select_tool_pack',
  'plan_model_call',
  'tool_pre_guard',
  'execute_or_stage',
  'observe_verify',
  'repair_retry',
  'update_focus',
  'style_reply',
  'persist_trace',
] as const

export type OwnerTurnGraphNode = (typeof OWNER_TURN_GRAPH_NODES)[number]

/** Hard cap on model/tool repair loops the live turn may run (roadmap node 9). */
export const OWNER_TURN_MAX_REPAIRS = 2

export interface OwnerTurnDurableState {
  activeFocus: FocusLite | null
  parkedFocuses: FocusLite[]
  pendingCards: Array<{ id: string; kind: 'ask_card' | 'approval'; actionType?: string | null }>
  checkpoints: Array<{ taskRef?: string; taskType: string; step: string }>
}

export interface OwnerTurnGraphInput {
  conversationId: string
  turnId?: string | null
  businessId: string
  surface?: string | null
  text: string
  listenMode: boolean
  replyToCardId?: string | null
  /** What the LIVE legacy turn decided — the comparison baseline. */
  legacy: {
    headTier: HeadTier
    headVia: string
    toolGroups: readonly string[]
    boundToolName: string | null
    allowMutations: boolean
    continuityBinding: string | null
    maxIterations: number
  }
}

/** The one isolated external call: load durable state. Injected so shadow
 * reuses the turn's already-fetched rows (zero extra DB) and tests fixture it. */
export type OwnerTurnStateLoader = () => Promise<OwnerTurnDurableState>

export interface OwnerTurnTrace {
  selectedFocus: { binding: string; action: string; focusId: string | null; reason: string }
  toolDecision: { packs: string[]; toolCount: number; plannedTool: string | null; planVia: string }
  guardResult: { allowed: boolean; reason: string }
  verification: { required: boolean; method: string }
  finalState: { effect: 'none' | 'read' | 'stage_card'; replyMode: string; focusUpdate: string; repairsCap: number }
}

export interface OwnerTurnAgreement {
  /** Pure fast-path vs live via (LG-4 scoring — null = not scoreable). */
  fastPath: boolean | null
  /** Graph continuity binding vs the live resolver's binding (null = legacy off). */
  focus: boolean | null
  /** Overlap of graph pack home-groups with the live selector's groups (0..1, null = no legacy groups). */
  toolOverlap: number | null
  /** Graph planned tool vs legacy bound tool (null = neither side bound). */
  plannedTool: boolean | null
  /** Hard verdict over the scoreable dimensions. */
  agree: boolean | null
  /** Disagreement classification labels (empty when agreeing). */
  disagreements: string[]
}

export interface OwnerTurnGraphResult {
  trace: OwnerTurnTrace
  agreement: OwnerTurnAgreement
  nodesRun: OwnerTurnGraphNode[]
  fastPath: HeadFastPathKind
}

const S = Annotation.Root({
  input: Annotation<OwnerTurnGraphInput>,
  durable: Annotation<OwnerTurnDurableState | null>({ reducer: (_a, b) => b, default: () => null }),
  fastPath: Annotation<HeadFastPathKind>({ reducer: (_a, b) => b, default: () => null }),
  continuity: Annotation<ContinuityDecision | null>({ reducer: (_a, b) => b, default: () => null }),
  policy: Annotation<{ listen: boolean; deny: boolean; call: boolean; allowMutations: boolean } | null>({ reducer: (_a, b) => b, default: () => null }),
  packs: Annotation<string[]>({ reducer: (_a, b) => b, default: () => [] }),
  toolNames: Annotation<string[]>({ reducer: (_a, b) => b, default: () => [] }),
  plannedTool: Annotation<string | null>({ reducer: (_a, b) => b, default: () => null }),
  planVia: Annotation<string>({ reducer: (_a, b) => b, default: () => 'model_choice' }),
  guard: Annotation<{ allowed: boolean; reason: string } | null>({ reducer: (_a, b) => b, default: () => null }),
  effect: Annotation<'none' | 'read' | 'stage_card'>({ reducer: (_a, b) => b, default: () => 'none' }),
  verification: Annotation<{ required: boolean; method: string } | null>({ reducer: (_a, b) => b, default: () => null }),
  repairsCap: Annotation<number>({ reducer: (_a, b) => b, default: () => OWNER_TURN_MAX_REPAIRS }),
  focusUpdate: Annotation<string>({ reducer: (_a, b) => b, default: () => 'none' }),
  replyMode: Annotation<string>({ reducer: (_a, b) => b, default: () => 'work' }),
  nodesRun: Annotation<OwnerTurnGraphNode[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
  result: Annotation<OwnerTurnGraphResult | null>({ reducer: (_a, b) => b, default: () => null }),
})

/** Mutating-tool heuristic shared with the pre-guard (names, not behaviour —
 * the real registry manifest guards the live path; shadow mirrors the rule). */
const READ_TOOL_RE = /^(get_|list_|search_|check_|analyze_|audit_|research_|fetch_|read_|compare_|recall_|simulate_|diagnose_|run_health|marketing_report|advisor_)/

function packHomeGroups(packs: string[]): string[] {
  // Mirrors PACK_HOME_GROUP without exporting internals: pack → prompt group.
  const map: Record<string, string[]> = {
    salah: ['salah'], finance: ['finance'], erp: ['erp'], staff_read: ['staff'], staff_dispatch: ['staff'],
    social: ['erp', 'content'], ads: ['growth'], browser: ['base'], website: ['website'], seo: ['growth'],
    creative: ['content'], cs: ['cs'], reminders: ['base'], plan: ['base'], workbench: ['base'],
    diag: ['diag'], cost: ['cost'], vision: ['vision'], todo: ['base'], research: ['growth'], camera: ['base'],
  }
  const out = new Set<string>()
  for (const p of packs) for (const g of map[p] ?? []) out.add(g)
  return [...out]
}

function scoreFastPathAgreement(kind: HeadFastPathKind, via: string, tier: HeadTier): boolean | null {
  if (tier === 'explicit' || via.startsWith('explicit') || via.startsWith('anthropic_down_explicit')) return null
  switch (kind) {
    case 'deny_kw': return via.startsWith('deny_kw')
    case 'call_intent': return via.startsWith('call_intent')
    case 'marketing_kw': return via.startsWith('marketing_kw') || via.startsWith('explicit_marketing')
    case 'routine_kw': return via.startsWith('routine_kw')
    default: return null
  }
}

export function buildOwnerTurnGraph(opts: {
  loadState: OwnerTurnStateLoader
  checkpointer?: BaseCheckpointSaver | null
}) {
  const graph = new StateGraph(S)
    .addNode('load_context', async () => ({
      durable: await opts.loadState(),
      nodesRun: ['load_context' as const],
    }))
    .addNode('classify_intent', (s) => {
      const d = s.durable ?? { activeFocus: null, parkedFocuses: [], pendingCards: [], checkpoints: [] }
      return {
        fastPath: classifyHeadFastPath(s.input.text),
        continuity: resolveContinuityDecision({
          text: s.input.text,
          listenMode: s.input.listenMode,
          replyToCardId: s.input.replyToCardId ?? null,
          pendingCards: d.pendingCards,
          activeFocus: d.activeFocus,
          parkedFocuses: d.parkedFocuses,
          checkpoints: d.checkpoints,
        }),
        nodesRun: ['classify_intent' as const],
      }
    })
    .addNode('policy_precheck', (s) => ({
      policy: {
        listen: s.input.listenMode,
        deny: s.fastPath === 'deny_kw',
        call: s.fastPath === 'call_intent',
        // Mutations are authorized only by structured state: a card answer, a
        // bound continuation of in-flight work, or the legacy gate's verdict.
        allowMutations:
          s.input.legacy.allowMutations
          || s.continuity?.binding === 'pending_card'
          || (s.continuity?.binding === 'active_focus' && s.continuity.action === 'resume'),
      },
      nodesRun: ['policy_precheck' as const],
    }))
    .addNode('select_tool_pack', (s) => {
      if (s.input.listenMode) {
        return { packs: [], toolNames: [], nodesRun: ['select_tool_pack' as const] }
      }
      const d = s.durable
      const packs: PackKey[] = []
      const card = d?.pendingCards.find((c) => c.id === (s.continuity?.cardId ?? ''))
      if (card?.actionType) for (const p of packsForPendingActionType(card.actionType)) if (!packs.includes(p)) packs.push(p)
      if (s.continuity?.binding === 'checkpoint' && d?.checkpoints[0]) {
        for (const p of packsForCheckpointTaskType(d.checkpoints[0].taskType)) if (!packs.includes(p)) packs.push(p)
      }
      for (const p of matchIntentPacks(s.input.text)) if (!packs.includes(p)) packs.push(p)
      const { names } = assemblePack(packs)
      return { packs: packs as string[], toolNames: names.slice(0, HEAD_TOOL_HARD_LIMIT), nodesRun: ['select_tool_pack' as const] }
    })
    .addNode('plan_model_call', (s) => {
      // Deterministic plans first (the graph's whole point): routine reads and
      // step-bound tools leave the model zero tool-choice freedom.
      const routine = detectRoutineIntent(s.input.text)
      if (routine) {
        const call = routineIntentCall(routine, s.input.text)
        if (call) return { plannedTool: call.toolName, planVia: 'routine_intent', nodesRun: ['plan_model_call' as const] }
      }
      if (s.input.legacy.boundToolName) {
        return { plannedTool: s.input.legacy.boundToolName, planVia: 'workflow_step_binding', nodesRun: ['plan_model_call' as const] }
      }
      return { plannedTool: null, planVia: 'model_choice', nodesRun: ['plan_model_call' as const] }
    })
    .addNode('tool_pre_guard', (s) => {
      const p = s.policy!
      if (p.listen) {
        return { guard: { allowed: false, reason: 'listen_mode_no_tools' }, nodesRun: ['tool_pre_guard' as const] }
      }
      const t = s.plannedTool
      if (!t) return { guard: { allowed: true, reason: 'model_choice_within_pack' }, nodesRun: ['tool_pre_guard' as const] }
      // Authorization first — an unauthorized write is refused for THAT reason
      // even when the pack wouldn't have carried the tool anyway.
      const isRead = READ_TOOL_RE.test(t)
      if (!isRead && !p.allowMutations) {
        return { guard: { allowed: false, reason: 'write_requires_authorization' }, nodesRun: ['tool_pre_guard' as const] }
      }
      if (s.toolNames.length > 0 && !s.toolNames.includes(t) && s.planVia === 'workflow_step_binding') {
        return { guard: { allowed: false, reason: 'bound_tool_not_in_pack' }, nodesRun: ['tool_pre_guard' as const] }
      }
      return { guard: { allowed: true, reason: isRead ? 'read_tool' : 'write_authorized' }, nodesRun: ['tool_pre_guard' as const] }
    })
    .addNode('execute_or_stage', (s) => {
      // SHADOW: prediction only — legacy executes. A blocked guard predicts no
      // effect; a read predicts a read; an authorized write predicts a staged
      // card (every mutating action goes through its approval card).
      const t = s.plannedTool
      const effect = !s.guard?.allowed || !t ? 'none' : READ_TOOL_RE.test(t) ? 'read' : 'stage_card'
      return { effect, nodesRun: ['execute_or_stage' as const] }
    })
    .addNode('observe_verify', (s) => ({
      verification:
        s.effect === 'none'
          ? { required: false, method: 'no_effect' }
          : s.effect === 'read'
            ? { required: true, method: 'tool_result_grounding' }
            : { required: true, method: 'claim_verifier_plus_owner_approval' },
      nodesRun: ['observe_verify' as const],
    }))
    .addNode('repair_retry', () => ({
      repairsCap: OWNER_TURN_MAX_REPAIRS,
      nodesRun: ['repair_retry' as const],
    }))
    .addNode('update_focus', (s) => {
      // Fail-closed contract: if this turn produced/kept an effect-bearing
      // binding, the focus update MUST be recordable; in shadow we record the
      // would-be transition. 'blocked_fail_closed' is what the live executor
      // must treat as "abort the write, tell the owner" (roadmap: no silent
      // fail-open for state corruption).
      const c = s.continuity
      const update =
        !c ? 'none'
        : c.binding === 'active_focus' ? 'touch_active_focus'
        : c.binding === 'pending_card' ? 'bind_card_focus'
        : c.binding === 'checkpoint' ? 'resume_checkpoint_focus'
        : c.binding === 'new_task' && c.action === 'park_and_start' ? 'park_then_create'
        : c.binding === 'new_task' ? 'create_focus'
        : 'none'
      return { focusUpdate: update, nodesRun: ['update_focus' as const] }
    })
    .addNode('style_reply', (s) => ({
      replyMode: s.policy?.listen ? 'listen_empathy' : s.effect === 'read' ? 'grounded_status' : s.effect === 'stage_card' ? 'card_handoff' : 'work',
      nodesRun: ['style_reply' as const],
    }))
    .addNode('persist_trace', (s) => {
      const legacy = s.input.legacy
      const c = s.continuity
      const fastPath = scoreFastPathAgreement(s.fastPath, legacy.headVia, legacy.headTier)
      const focus = legacy.continuityBinding === null ? null : legacy.continuityBinding === (c?.binding ?? 'none')
      const graphGroups = packHomeGroups(s.packs)
      const toolOverlap = legacy.toolGroups.length === 0
        ? null
        : graphGroups.filter((g) => legacy.toolGroups.includes(g)).length / new Set([...legacy.toolGroups]).size
      const plannedTool =
        s.plannedTool === null && legacy.boundToolName === null
          ? null
          : s.plannedTool === legacy.boundToolName
            || (s.planVia === 'routine_intent' && legacy.boundToolName === null) // routine reads run before the legacy binding — not a conflict
      const disagreements: string[] = []
      if (fastPath === false) disagreements.push('fast_path')
      if (focus === false) disagreements.push('focus_binding')
      if (toolOverlap !== null && toolOverlap < 0.5) disagreements.push('tool_groups')
      if (plannedTool === false) disagreements.push('planned_tool')
      const scoreable = [fastPath, focus, plannedTool].filter((v) => v !== null) as boolean[]
      const agree = scoreable.length === 0 && toolOverlap === null ? null : disagreements.length === 0
      const result: OwnerTurnGraphResult = {
        fastPath: s.fastPath,
        trace: {
          selectedFocus: {
            binding: c?.binding ?? 'none',
            action: c?.action ?? 'proceed',
            focusId: c?.focusId ?? null,
            reason: c?.reason ?? 'resolver_unavailable',
          },
          toolDecision: { packs: s.packs, toolCount: s.toolNames.length, plannedTool: s.plannedTool, planVia: s.planVia },
          guardResult: s.guard ?? { allowed: false, reason: 'guard_not_run' },
          verification: s.verification ?? { required: false, method: 'not_evaluated' },
          finalState: { effect: s.effect, replyMode: s.replyMode, focusUpdate: s.focusUpdate, repairsCap: s.repairsCap },
        },
        agreement: { fastPath, focus, toolOverlap, plannedTool: typeof plannedTool === 'boolean' ? plannedTool : null, agree, disagreements },
        nodesRun: [...s.nodesRun, 'persist_trace'],
      }
      return { result, nodesRun: ['persist_trace' as const] }
    })
    .addEdge(START, 'load_context')
    .addEdge('load_context', 'classify_intent')
    .addEdge('classify_intent', 'policy_precheck')
    .addEdge('policy_precheck', 'select_tool_pack')
    .addEdge('select_tool_pack', 'plan_model_call')
    .addEdge('plan_model_call', 'tool_pre_guard')
    .addEdge('tool_pre_guard', 'execute_or_stage')
    .addEdge('execute_or_stage', 'observe_verify')
    .addEdge('observe_verify', 'repair_retry')
    .addEdge('repair_retry', 'update_focus')
    .addEdge('update_focus', 'style_reply')
    .addEdge('style_reply', 'persist_trace')
    .addEdge('persist_trace', END)

  return graph.compile({ checkpointer: opts.checkpointer ?? undefined })
}

/**
 * Run the owner-turn graph in shadow for one live turn. Durable when the
 * shared checkpointer is on (stable thread id `owner_turn:<conv>:<turn>` in
 * the explicit `owner_turn` namespace); MemorySaver-free otherwise (a shadow
 * decision needs no persistence to be comparable). Fail-open: null.
 */
export async function runOwnerTurnGraphShadow(
  input: OwnerTurnGraphInput,
  loadState: OwnerTurnStateLoader,
): Promise<OwnerTurnGraphResult | null> {
  try {
    const checkpointer = getGraphCheckpointer()
    const compiled = buildOwnerTurnGraph({ loadState, checkpointer })
    const config = {
      recursionLimit: 32,
      configurable: {
        thread_id: `owner_turn:${input.conversationId}:${input.turnId ?? 'na'}`,
        checkpoint_ns: 'owner_turn',
      },
    }
    const out = await compiled.invoke({ input }, config)
    return out.result ?? null
  } catch (err) {
    console.warn('[owner-turn-graph] shadow failed open:', err instanceof Error ? err.message : err)
    return null
  }
}

/** Test helper: a compiled graph over an in-memory saver (restart tests). */
export function buildOwnerTurnGraphForTests(loadState: OwnerTurnStateLoader) {
  return buildOwnerTurnGraph({ loadState, checkpointer: new MemorySaver() })
}
