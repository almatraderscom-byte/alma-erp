/**
 * Phase 33 — the REAL 12-node owner-turn graph in shadow.
 *
 * Proves the roadmap gates:
 *  - topology: all 12 nodes exist and run in order,
 *  - 100% of traces carry focus / tool decision / guard / verification /
 *    final state,
 *  - restart between ANY two nodes resumes from the checkpoint (MemorySaver,
 *    fresh graph instance per resume = process restart),
 *  - ≥98% shadow agreement on the low-risk replay corpus, disagreements
 *    classified,
 *  - the guard fails closed: unauthorized writes and listen-mode tools never
 *    pass, and shadow never predicts an executed effect for them.
 */
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { MemorySaver } from '@langchain/langgraph'
import {
  buildOwnerTurnGraph,
  OWNER_TURN_GRAPH_NODES,
  OWNER_TURN_MAX_REPAIRS,
  type OwnerTurnDurableState,
  type OwnerTurnGraphInput,
} from '@/agent/lib/graph/owner-turn-graph'
import { loadCorpus } from '@/agent/replay/run-agent-replay'
import { classifyHeadFastPath } from '@/agent/lib/models/head-router'

const FIXTURES = join(process.cwd(), 'src/agent/replay/fixtures')

const EMPTY_STATE: OwnerTurnDurableState = {
  activeFocus: null, parkedFocuses: [], pendingCards: [], checkpoints: [],
}

function makeInput(partial: Partial<OwnerTurnGraphInput>): OwnerTurnGraphInput {
  return {
    conversationId: 'c-test',
    turnId: 't-1',
    businessId: 'ALMA_LIFESTYLE',
    text: 'aj koto sale holo?',
    listenMode: false,
    legacy: {
      headTier: 'light', headVia: 'routine_kw', toolGroups: ['erp'],
      boundToolName: null, allowMutations: false, continuityBinding: null, maxIterations: 12,
    },
    ...partial,
  }
}

async function runGraph(input: OwnerTurnGraphInput, state: OwnerTurnDurableState = EMPTY_STATE) {
  const g = buildOwnerTurnGraph({ loadState: async () => state, checkpointer: null })
  const out = await g.invoke({ input }, { recursionLimit: 32 })
  return out.result!
}

describe('topology', () => {
  it('runs all 12 roadmap nodes in order', async () => {
    const r = await runGraph(makeInput({}))
    expect(r.nodesRun).toEqual([...OWNER_TURN_GRAPH_NODES])
    expect(OWNER_TURN_GRAPH_NODES).toHaveLength(12)
  })
})

describe('trace completeness (exit gate: 100%)', () => {
  it('every corpus case yields all five trace elements', async () => {
    const { cases } = loadCorpus(FIXTURES)
    for (const c of cases) {
      const listen = c.fakes?.personalClassification === 'personal' && classifyHeadFastPath(c.latestMessage) === 'personal_hint'
      const r = await runGraph(
        makeInput({
          text: c.latestMessage,
          listenMode: listen,
          replyToCardId: c.replyTo?.id ?? null,
          legacy: { headTier: 'light', headVia: 'triage', toolGroups: [], boundToolName: null, allowMutations: false, continuityBinding: null, maxIterations: 12 },
        }),
        {
          activeFocus: c.context?.activeWorkflow
            ? { goal: c.context.activeWorkflow.goal, kind: c.context.activeWorkflow.kind, status: 'active', completedSteps: c.context.activeWorkflow.verifiedEffects ?? [] }
            : null,
          parkedFocuses: [],
          pendingCards: c.context?.pendingCard ? [{ id: c.context.pendingCard.id, kind: c.context.pendingCard.kind, actionType: c.context.pendingCard.actionType ?? null }] : [],
          checkpoints: c.context?.checkpoint ? [{ taskType: c.context.checkpoint.taskType, step: c.context.checkpoint.step }] : [],
        },
      )
      expect(r.trace.selectedFocus, c.id).toBeDefined()
      expect(r.trace.toolDecision, c.id).toBeDefined()
      expect(r.trace.guardResult, c.id).toBeDefined()
      expect(r.trace.verification, c.id).toBeDefined()
      expect(r.trace.finalState, c.id).toBeDefined()
      expect(r.trace.finalState.repairsCap).toBe(OWNER_TURN_MAX_REPAIRS)
    }
  }, 30_000)
})

describe('restart-resume between every node pair (exit gate)', () => {
  it('interrupting before each node, then resuming on a FRESH graph instance, matches the uninterrupted run', async () => {
    const input = makeInput({})
    const baseline = await runGraph(input)
    // Same MemorySaver shared across "restarts"; new compiled graph each time.
    for (const node of OWNER_TURN_GRAPH_NODES.slice(1)) {
      const saver = new MemorySaver()
      const config = { recursionLimit: 32, configurable: { thread_id: `restart-${node}` } }
      const first = buildOwnerTurnGraph({ loadState: async () => EMPTY_STATE, checkpointer: saver })
      await first.invoke({ input }, { ...config, interruptBefore: [node] })
      // "Process restart": a brand-new graph instance over the same saver.
      const second = buildOwnerTurnGraph({ loadState: async () => EMPTY_STATE, checkpointer: saver })
      const resumed = await second.invoke(null, config)
      expect(resumed.result, `resume before ${node}`).not.toBeNull()
      expect(JSON.stringify(resumed.result!.trace), `trace after resume before ${node}`)
        .toEqual(JSON.stringify(baseline.trace))
    }
  }, 30_000)
})

describe('guard fails closed (no silent fail-open for writes)', () => {
  it('listen mode: zero tools, zero predicted effects', async () => {
    const r = await runGraph(makeInput({ text: 'mon ta valo nei aj', listenMode: true, legacy: { headTier: 'personal', headVia: 'personal_emotional', toolGroups: [], boundToolName: null, allowMutations: false, continuityBinding: null, maxIterations: 12 } }))
    expect(r.trace.toolDecision.toolCount).toBe(0)
    expect(r.trace.guardResult.allowed).toBe(false)
    expect(r.trace.finalState.effect).toBe('none')
    expect(r.trace.finalState.replyMode).toBe('listen_empathy')
  })
  it('an unauthorized write plan is refused and predicts no effect', async () => {
    const r = await runGraph(makeInput({
      text: 'হ্যাঁ',
      legacy: { headTier: 'light', headVia: 'sticky_followup', toolGroups: ['finance'], boundToolName: 'log_expense', allowMutations: false, continuityBinding: null, maxIterations: 12 },
    }))
    // No card/focus state → resolver binds nothing → mutation unauthorized.
    expect(r.trace.guardResult.allowed).toBe(false)
    expect(r.trace.guardResult.reason).toBe('write_requires_authorization')
    expect(r.trace.finalState.effect).toBe('none')
  })
  it('the same write is allowed once a pending card authorizes it (stage, never direct)', async () => {
    const r = await runGraph(
      makeInput({
        text: 'হ্যাঁ',
        replyToCardId: 'pa-1',
        legacy: { headTier: 'light', headVia: 'sticky_followup', toolGroups: ['finance'], boundToolName: 'log_expense', allowMutations: true, continuityBinding: 'pending_card', maxIterations: 12 },
      }),
      { ...EMPTY_STATE, pendingCards: [{ id: 'pa-1', kind: 'approval', actionType: 'log_expense' }] },
    )
    expect(r.trace.guardResult.allowed).toBe(true)
    expect(r.trace.finalState.effect).toBe('stage_card')
    expect(r.trace.verification.method).toBe('claim_verifier_plus_owner_approval')
  })
})

describe('shadow agreement on the corpus (exit gate: ≥98%, disagreements classified)', () => {
  it('scores ≥98% agreement; every disagreement carries a classification label', async () => {
    const { cases } = loadCorpus(FIXTURES)
    let scored = 0
    let agreed = 0
    const labels: Record<string, number> = {}
    for (const c of cases) {
      const listen = c.fakes?.personalClassification === 'personal' && classifyHeadFastPath(c.latestMessage) === 'personal_hint'
      // Legacy baseline for the comparison = what the live path decides today.
      // These are the fixture expectations that agent-replay/continuity-replay
      // lock at 100% against the REAL head router + resolver — i.e. the
      // verified live decisions, not hand-waving.
      const liveBinding = c.expect2.binding === 'active_workflow' ? 'active_focus' : c.expect2.binding ?? null
      const r = await runGraph(
        makeInput({
          text: c.latestMessage,
          listenMode: listen,
          replyToCardId: c.replyTo?.id ?? null,
          legacy: {
            headTier: c.expect2.headTier ?? (listen ? 'personal' : 'light'),
            // The live router's `via` mirrors its first-matching fast path —
            // for unasserted fixtures the real classifier IS that value
            // (deterministic regex first-match, verified in Layer B).
            headVia: c.expect2.fastPath ?? classifyHeadFastPath(c.latestMessage) ?? (listen ? 'personal_emotional' : 'triage'),
            toolGroups: [],
            boundToolName: null,
            allowMutations: false,
            continuityBinding: liveBinding,
            maxIterations: 12,
          },
        }),
        {
          activeFocus: c.context?.activeWorkflow
            ? { goal: c.context.activeWorkflow.goal, kind: c.context.activeWorkflow.kind, status: 'active', completedSteps: c.context.activeWorkflow.verifiedEffects ?? [] }
            : null,
          parkedFocuses: [],
          pendingCards: c.context?.pendingCard ? [{ id: c.context.pendingCard.id, kind: c.context.pendingCard.kind, actionType: c.context.pendingCard.actionType ?? null }] : [],
          checkpoints: c.context?.checkpoint ? [{ taskType: c.context.checkpoint.taskType, step: c.context.checkpoint.step }] : [],
        },
      )
      if (r.agreement.agree !== null) {
        scored++
        if (r.agreement.agree) agreed++
        else for (const l of r.agreement.disagreements) labels[l] = (labels[l] ?? 0) + 1
      }
      if (r.agreement.agree === false) {
        expect(r.agreement.disagreements.length, c.id).toBeGreaterThan(0)
      }
    }
    expect(scored).toBeGreaterThanOrEqual(50)
    const rate = agreed / scored
    // eslint-disable-next-line no-console
    console.log(`[owner-turn-graph] corpus shadow agreement ${(rate * 100).toFixed(1)}% (${agreed}/${scored}); disagreements:`, labels)
    expect(rate).toBeGreaterThanOrEqual(0.98)
  }, 30_000)
})
