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
import { describe, expect, it, vi, beforeEach } from 'vitest'

const mockPrisma = vi.hoisted(() => ({ agentPendingAction: { count: vi.fn() } }))
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

import {
  PLAN_TURN_WITHHELD,
  chooseRoundBoundTool,
  filterToolsForPlanTurn,
  isPlanFirstTurn,
  planFirstNote,
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

  it('returns to the required contract after the plan round', () => {
    expect(chooseRoundBoundTool({
      iteration: 1,
      planTool: null,
      contractTool: 'get_orders',
      workflowTool: 'update_order',
    })).toBe('get_orders')
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
