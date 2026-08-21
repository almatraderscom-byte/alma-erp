/**
 * Plan before work — owner ask 2026-07-26.
 *
 * "agent ke ekta boro task dile, she bar bar ektu ektu kore 20/30 sec kore amk
 * bar bar approve cacche … ami tar ei kajer plan e dekhte pai ni."
 *
 * He is not objecting to being asked. He is objecting to being asked piecemeal,
 * forever, with no plan he can see. So the first turn of a big job plans and
 * asks everything at once — and the write tools are withheld so it cannot start
 * the job while claiming to plan.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi, beforeEach } from 'vitest'

const mockPrisma = vi.hoisted(() => ({ agentPendingAction: { count: vi.fn() } }))
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

import {
  PLAN_TURN_WITHHELD,
  chooseRoundBoundTool,
  filterToolsForPlanTurn,
  isPlanFirstTurn,
  normalizeProspectivePlanInput,
  partitionProspectivePlanCalls,
  planFirstNote,
  prospectivePlanExitText,
  shouldInjectProspectivePlanTool,
  shouldWithholdProspectivePlanRoundProse,
} from '@/agent/lib/plan-first'

describe('prospective plan binding', () => {
  it('puts make_plan before a contract or workflow tool on round zero', () => {
    expect(chooseRoundBoundTool({
      iteration: 0,
      planTool: 'make_plan',
      contractTool: 'get_orders',
      workflowTool: 'update_order',
    })).toBe('make_plan')
  })

  it('keeps make_plan ahead of other bindings until the caller reports success', () => {
    expect(chooseRoundBoundTool({
      iteration: 1,
      planTool: 'make_plan',
      contractTool: 'get_orders',
      workflowTool: 'update_order',
    })).toBe('make_plan')

    expect(chooseRoundBoundTool({
      iteration: 1,
      planTool: null,
      contractTool: 'get_orders',
      workflowTool: 'update_order',
    })).toBe('get_orders')
  })

  it('injects make_plan into round zero when the router omitted the plan pack', () => {
    expect(shouldInjectProspectivePlanTool({
      planFirst: true,
      planSatisfied: false,
      lastBudgetRound: false,
      shippedToolNames: ['get_dashboard_snapshot', 'get_orders'],
    })).toBe(true)
  })

  it('re-adds make_plan on later unsatisfied rounds but not after success or in wrap-up', () => {
    expect(shouldInjectProspectivePlanTool({
      planFirst: true,
      planSatisfied: false,
      lastBudgetRound: false,
      shippedToolNames: [],
    })).toBe(true)
    expect(shouldInjectProspectivePlanTool({
      planFirst: true,
      planSatisfied: true,
      lastBudgetRound: false,
      shippedToolNames: [],
    })).toBe(false)
    expect(shouldInjectProspectivePlanTool({
      planFirst: true,
      planSatisfied: false,
      lastBudgetRound: true,
      shippedToolNames: [],
    })).toBe(false)
  })

  it('withholds provider prose only while the forced prospective plan is being created', () => {
    expect(shouldWithholdProspectivePlanRoundProse('make_plan')).toBe(true)
    expect(shouldWithholdProspectivePlanRoundProse('get_orders')).toBe(false)
    expect(shouldWithholdProspectivePlanRoundProse(null)).toBe(false)

    const source = readFileSync(new URL('../models/run-owner-turn.ts', import.meta.url), 'utf8')
    expect(source).toContain('&& !ownerRequirements.planFirst')
    expect(source).toContain('if (liveProseEnabled && !withholdProspectivePlanProse)')
    expect(source).toContain("iterationText = withholdProspectivePlanProse ? '' : cleanedIterationText")
    expect(source).toContain('if (withholdProspectivePlanProse && calls.length === 0 && !signal?.aborted)')
    expect(source).toContain('&& !prospectivePlanTrackerVisible)')
    expect(source).toContain('prospectivePlanTrackerVisible = true')
  })

  it('accepts one make_plan and rejects sibling work or duplicate plans', () => {
    const calls = [
      { id: 'work-before-plan', name: 'get_orders' },
      { id: 'plan', name: 'make_plan' },
      { id: 'duplicate-plan', name: 'make_plan' },
    ]
    const partition = partitionProspectivePlanCalls(calls, true)

    expect(partition.accepted.map((call) => call.id)).toEqual(['plan'])
    expect(partition.rejected.map((call) => call.id)).toEqual([
      'work-before-plan', 'duplicate-plan',
    ])

    const source = readFileSync(new URL('../models/run-owner-turn.ts', import.meta.url), 'utf8')
    expect(source).toContain('if (!withholdProspectivePlanProse)')
    expect(source).toContain('!acceptedProspectivePlanCalls.has(call)')
    expect(source).toContain('if (!hideProspectivePlanControl)')
  })

  it('reports final-iteration plan projection outcomes explicitly', () => {
    expect(prospectivePlanExitText(true)).toContain('Step tracker তৈরি হয়েছে')
    expect(prospectivePlanExitText(true)).toContain('কোনো business action চালাইনি')
    expect(prospectivePlanExitText(false)).toContain('step tracker verify করা যায়নি')

    const source = readFileSync(new URL('../models/run-owner-turn.ts', import.meta.url), 'utf8')
    expect(source).toContain('const prospectivePlanCreatedAfterLoop = toolRecords.some')
    expect(source).toContain('attempt < 2 && !prospectivePlanTrackerVisible')
    expect(source).toContain('prospectivePlanExitText(prospectivePlanTrackerVisible)')
    expect(source).not.toContain('const projectionFailure =')
  })

  it('recovers the exact four owner-authored steps from a legacy plan payload', () => {
    const input = normalizeProspectivePlanInput(
      {
        plan: [
          { step: '1. Inspect dashboard', description: 'wrong fallback text' },
          { step: '2. Inspect orders' },
          { step: '3. Inspect approvals' },
          { step: '4. Cross-check and summarize' },
        ],
      },
      'Before work: 1 Inspect dashboard; 2 Inspect orders; 3 Inspect approvals; 4 Cross-check and summarize.',
    )
    expect(input.steps.map((step) => step.action)).toEqual([
      'Inspect dashboard',
      'Inspect orders',
      'Inspect approvals',
      'Cross-check and summarize',
    ])
  })

  it('uses an explicit numbered owner checklist when the model omits steps', () => {
    const input = normalizeProspectivePlanInput(
      { goal: 'Read-only inspection', steps: [] },
      'Create four steps: 1 Inspect todays dashboard snapshot; 2 Inspect pending orders; '
        + '3 Inspect pending approvals; 4 Cross-check and summarize. Then execute them in order. Do not mutate data.',
    )
    expect(input.goal).toBe('Read-only inspection')
    expect(input.steps.map((step) => step.action)).toEqual([
      'Inspect todays dashboard snapshot',
      'Inspect pending orders',
      'Inspect pending approvals',
      'Cross-check and summarize.',
    ])
  })
})

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.agentPendingAction.count.mockResolvedValue(0)
})

describe('when a turn should plan first', () => {
  it('a big job in a fresh conversation plans', async () => {
    expect(await isPlanFirstTurn({ conversationId: 'c1', deepWork: true })).toBe(true)
  })

  it('an ordinary request does not', async () => {
    expect(await isPlanFirstTurn({ conversationId: 'c1', deepWork: false })).toBe(false)
  })

  // The moment a card exists, planning is over — this must never fire twice and
  // trap him in a planning loop.
  it('never fires again once the conversation has staged anything', async () => {
    mockPrisma.agentPendingAction.count.mockResolvedValue(1)
    expect(await isPlanFirstTurn({ conversationId: 'c1', deepWork: true })).toBe(false)
  })

  it('fails open to normal work if the check itself breaks', async () => {
    mockPrisma.agentPendingAction.count.mockRejectedValue(new Error('db down'))
    expect(await isPlanFirstTurn({ conversationId: 'c1', deepWork: true })).toBe(false)
  })
})

describe('what a planning turn may touch', () => {
  const tools = [
    { name: 'audit_product_seo' },
    { name: 'get_website_catalog' },
    { name: 'fetch_website_page' },
    { name: 'draft_seo_fixes' },
    { name: 'publish_product' },
    { name: 'send_customer_message' },
  ]

  it('keeps every reading tool — a plan written without looking is worthless', () => {
    const { tools: kept } = filterToolsForPlanTurn(tools)
    expect(kept.map((t) => t.name)).toEqual([
      'audit_product_seo',
      'get_website_catalog',
      'fetch_website_page',
    ])
  })

  it('takes away everything that stages or changes work', () => {
    const { removed } = filterToolsForPlanTurn(tools)
    expect(removed).toEqual(['draft_seo_fixes', 'publish_product', 'send_customer_message'])
  })

  it('the withheld set covers writing, publishing, spending and dispatching', () => {
    for (const t of ['draft_seo_fixes', 'publish_product', 'launch_campaign', 'dispatch_staff_tasks']) {
      expect(PLAN_TURN_WITHHELD.has(t)).toBe(true)
    }
  })
})

describe('what the planning turn is told', () => {
  const note = planFirstNote()

  it('forbids starting the work', () => {
    expect(note).toContain('কোনো কাজ শুরু কোরো না')
    expect(note).toContain('approval card বানিও না')
  })

  it('demands the real count before the plan', () => {
    expect(note).toContain('আসল মাপটা নাও')
    expect(note).toContain('অনুমানে প্ল্যান লিখো না')
  })

  // The specific thing he was most annoyed by.
  it('demands every question at once, not a drip', () => {
    expect(note).toContain('সব** প্রশ্ন ও অনুমতি একসাথে')
    expect(note).toContain('বারবার অনুমতি চাইবে না')
  })
})
