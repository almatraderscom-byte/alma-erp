import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the briefing loader so getActionCards is fully deterministic.
const mockBriefing = vi.hoisted(() => ({ buildOwnerBriefingData: vi.fn() }))
vi.mock('@/agent/lib/owner-briefing-data', () => mockBriefing)

import {
  buildActionCards,
  renderActionCardsBangla,
  getActionCards,
  type ActionCard,
} from '@/agent/lib/action-cards'

type Reorder = {
  id: string
  name: string
  currentStock: number
  dailyRate: number
  daysOfStock: number
  suggestedQty: number
  urgency: 'high' | 'normal'
  reason: string
}
function reorder(p: Partial<Reorder> & { id: string; name: string }): Reorder {
  return {
    currentStock: 0, dailyRate: 1, daysOfStock: 0, suggestedQty: 10,
    urgency: 'normal', reason: 'স্টক কম', ...p,
  }
}
type Issue = {
  type: 'stuck_pending' | 'pile_up' | 'high_cancel' | 'high_return' | 'mismatch'
  severity: 'high' | 'normal'
  detail: string
  count?: number
  orders?: string[]
}

describe('buildActionCards — pure insight→action mapping', () => {
  it('maps a reorder suggestion into a one-tap add_owner_todo card', () => {
    const cards = buildActionCards({
      reorderSuggestions: [reorder({ id: 'p1', name: 'Kurti', suggestedQty: 24, urgency: 'high', reason: '৩ দিনের স্টক বাকি' })],
      orderIssues: [],
    })
    expect(cards).toHaveLength(1)
    const c = cards[0]
    expect(c.id).toBe('stock:p1')
    expect(c.area).toBe('stock')
    expect(c.urgency).toBe('high')
    expect(c.insight).toContain('Kurti')
    expect(c.recommendedAction).toContain('রিঅর্ডার')
    expect(c.action.tool).toBe('add_owner_todo')
    expect(c.action.params.title).toContain('Kurti')
    expect(c.action.params.title).toContain('24')
    expect(c.action.params.priority).toBe('high')
  })

  it('maps a stuck_pending order issue into a follow-up todo card', () => {
    const cards = buildActionCards({
      reorderSuggestions: [],
      orderIssues: [{ type: 'stuck_pending', severity: 'high', detail: '৫টি অর্ডার ৩ দিন pending' } as Issue],
    })
    expect(cards).toHaveLength(1)
    const c = cards[0]
    expect(c.id).toBe('orders:stuck_pending')
    expect(c.area).toBe('orders')
    expect(c.insight).toContain('pending')
    expect(c.action.tool).toBe('add_owner_todo')
    expect(c.action.params.priority).toBe('high')
  })

  it('orders high-urgency first, stock ahead of orders within a tier', () => {
    const cards = buildActionCards({
      reorderSuggestions: [
        reorder({ id: 'lo', name: 'NormalStock', urgency: 'normal' }),
        reorder({ id: 'hi', name: 'UrgentStock', urgency: 'high' }),
      ],
      orderIssues: [
        { type: 'pile_up', severity: 'high', detail: 'pile up' } as Issue,
        { type: 'mismatch', severity: 'normal', detail: 'mismatch' } as Issue,
      ],
    })
    // high tier: stock(UrgentStock) then orders(pile_up); normal tier: stock(NormalStock) then orders(mismatch)
    expect(cards.map((c) => c.id)).toEqual(['stock:hi', 'orders:pile_up', 'stock:lo', 'orders:mismatch'])
  })

  it('respects the limit', () => {
    const many = Array.from({ length: 12 }, (_, i) => reorder({ id: `p${i}`, name: `P${i}` }))
    const cards = buildActionCards({ reorderSuggestions: many, orderIssues: [] }, { limit: 3 })
    expect(cards).toHaveLength(3)
  })

  it('skips unknown order-issue types it has no action for', () => {
    const cards = buildActionCards({
      reorderSuggestions: [],
      // @ts-expect-error — deliberately unknown type
      orderIssues: [{ type: 'something_new', severity: 'high', detail: 'x' }],
    })
    expect(cards).toHaveLength(0)
  })

  it('returns no cards when there is nothing actionable', () => {
    expect(buildActionCards({ reorderSuggestions: [], orderIssues: [] })).toHaveLength(0)
  })
})

describe('renderActionCardsBangla', () => {
  it('reassures when there are no cards', () => {
    const msg = renderActionCardsBangla([])
    expect(msg).toContain('জরুরি কিছু নেই')
  })

  it('renders a numbered, tappable list with the action label', () => {
    const cards: ActionCard[] = [
      {
        id: 'stock:p1', area: 'stock', urgency: 'high',
        insight: 'Kurti: স্টক কম', recommendedAction: '~২৪টি রিঅর্ডার করুন',
        action: { tool: 'add_owner_todo', params: {}, label: 'রিঅর্ডার টুডুতে যোগ করুন' },
      },
    ]
    const msg = renderActionCardsBangla(cards)
    expect(msg).toContain('এক-ট্যাপ অ্যাকশন কার্ড')
    expect(msg).toContain('Kurti')
    expect(msg).toContain('রিঅর্ডার টুডুতে যোগ করুন')
    expect(msg).toContain('১.') // Bangla numeral 1
  })
})

describe('getActionCards — read-only briefing wrapper', () => {
  beforeEach(() => vi.clearAllMocks())

  it('loads the briefing and returns ready-to-show cards', async () => {
    mockBriefing.buildOwnerBriefingData.mockResolvedValue({
      reorderSuggestions: [reorder({ id: 'p1', name: 'Kurti', urgency: 'high' })],
      orderIssues: [{ type: 'pile_up', severity: 'high', detail: '১৮টি pending জমেছে' }],
    })
    const res = await getActionCards()
    expect(res.cards).toHaveLength(2)
    expect(res.summaryBangla).toContain('এক-ট্যাপ অ্যাকশন কার্ড')
  })

  it('fails safe (empty) when the briefing blows up', async () => {
    mockBriefing.buildOwnerBriefingData.mockRejectedValue(new Error('boom'))
    const res = await getActionCards()
    expect(res.cards).toHaveLength(0)
    expect(res.summaryBangla).toContain('জরুরি কিছু নেই')
  })
})
