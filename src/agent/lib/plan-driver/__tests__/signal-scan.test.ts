import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock prisma + planner + briefing BEFORE importing the module under test.
const mockPrisma = vi.hoisted(() => ({
  agentKvSetting: { findUnique: vi.fn(), upsert: vi.fn() },
  agentPlan: { findUnique: vi.fn() },
}))
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

const mockPlanner = vi.hoisted(() => ({
  createPlan: vi.fn(),
  enrollPlanForAutodrive: vi.fn(),
  // re-export the real terminal-set semantics the module relies on
  TERMINAL_AUTODRIVE_STATES: new Set(['done', 'failed', 'abandoned']),
}))
vi.mock('@/agent/lib/planner', () => mockPlanner)

const mockBriefing = vi.hoisted(() => ({ buildOwnerBriefingData: vi.fn() }))
vi.mock('@/agent/lib/owner-briefing-data', () => mockBriefing)

// Every self-created plan now gets its own drive conversation (without one the
// executor cannot run a head turn at all) — stub the creation here.
const mockDriveConv = vi.hoisted(() => ({
  ensureDriveConversation: vi.fn().mockResolvedValue('conv-drive-1'),
  getDriveConversationId: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/agent/lib/plan-driver/drive-conversation', () => mockDriveConv)

// notify-owner is fire-and-forget — stub it so no real push happens.
vi.mock('@/agent/lib/notify-owner', () => ({ notifyOwnerIfAway: vi.fn().mockResolvedValue({ skipped: true }) }))

import {
  selectDrivableSignals,
  scanSignalsToPlanDrive,
  MAX_SIGNALS_PER_SCAN,
  SIGNAL_SCAN_INTERVAL_MIN,
} from '@/agent/lib/plan-driver/signal-scan'

// Minimal briefing factory — only the fields the selector reads.
function briefing(overrides: Record<string, unknown> = {}) {
  return {
    today: '2026-06-29',
    sales: null,
    pendingOrders: null,
    inventory: null,
    reorderSuggestions: [],
    csWaiting: null,
    adsDigest: null,
    staffYesterday: null,
    staffPatterns: [],
    returns: null,
    pricing: null,
    orderIssues: [],
    decisions: [],
    ownerDecisionMemoryCount: 0,
    generatedAt: '2026-06-29T00:00:00Z',
    ...overrides,
  } as unknown as Parameters<typeof selectDrivableSignals>[0]
}

describe('selectDrivableSignals — turns business signals into drivable plans', () => {
  it('picks ONLY high-urgency reorders and keys them by sku (stable across days)', () => {
    const sigs = selectDrivableSignals(
      briefing({
        reorderSuggestions: [
          { id: 'FM-133', name: '133 সেট', suggestedQty: 20, urgency: 'high', reason: '২ দিনের স্টক', currentStock: 4, dailyRate: 2, daysOfStock: 2 },
          { id: 'FM-999', name: '999 সেট', suggestedQty: 5, urgency: 'normal', reason: 'low-ish', currentStock: 9, dailyRate: 1, daysOfStock: 9 },
        ],
      }),
    )
    const stock = sigs.filter((s) => s.area === 'stock')
    expect(stock).toHaveLength(1)
    expect(stock[0].signalKey).toBe('stock:FM-133')
    expect(stock[0].urgency).toBe('high')
    // key must NOT contain the daily-changing quantity
    expect(stock[0].signalKey).not.toContain('20')
  })

  it('picks high-severity order issues keyed by TYPE, not the daily count', () => {
    const sigs = selectDrivableSignals(
      briefing({
        orderIssues: [
          { type: 'stuck_pending', severity: 'high', detail: '5টি অর্ডার ৩ দিন pending', count: 5 },
          { type: 'high_return', severity: 'normal', detail: 'return একটু বেশি' },
        ],
      }),
    )
    const orders = sigs.filter((s) => s.area === 'orders')
    expect(orders).toHaveLength(1)
    expect(orders[0].signalKey).toBe('orders:stuck_pending')
    // Same issue type tomorrow with a different count → SAME key (dedup holds).
    const tomorrow = selectDrivableSignals(
      briefing({ orderIssues: [{ type: 'stuck_pending', severity: 'high', detail: '8টি অর্ডার ৪ দিন pending', count: 8 }] }),
    )
    expect(tomorrow[0].signalKey).toBe('orders:stuck_pending')
  })

  it('raises a customer signal only when the 24h window is closing', () => {
    expect(selectDrivableSignals(briefing({ csWaiting: { unrepliedCount: 9, nearWindowCount: 0, openAlerts: 0 } })))
      .toHaveLength(0)
    const sigs = selectDrivableSignals(briefing({ csWaiting: { unrepliedCount: 3, nearWindowCount: 2, openAlerts: 0 } }))
    expect(sigs).toHaveLength(1)
    expect(sigs[0].signalKey).toBe('customers:near_window')
    expect(sigs[0].area).toBe('customers')
  })

  it('orders high-urgency first and caps the batch', () => {
    const sigs = selectDrivableSignals(
      briefing({
        reorderSuggestions: Array.from({ length: 6 }, (_, i) => ({
          id: `SKU-${i}`, name: `P${i}`, suggestedQty: 10, urgency: 'high', reason: 'low', currentStock: 1, dailyRate: 1, daysOfStock: 1,
        })),
        returns: { flags: ['রিটার্ন হার বেশি'], totalReturns: 9, returnRatePct: 12 },
      }),
    )
    expect(sigs.length).toBeLessThanOrEqual(MAX_SIGNALS_PER_SCAN)
    // the normal-urgency return flag is pushed out by the high-urgency stock ones
    expect(sigs.every((s) => s.urgency === 'high')).toBe(true)
  })

  // Owner ruling 2026-07-25: staff performance belongs to the Office Manager
  // agent. Every staff plan this scanner ever created died unrun, and he kept
  // switching Plan-Drive off because of them.
  it('NEVER creates a staff follow-up signal, however bad the numbers look', () => {
    const sigs = selectDrivableSignals(
      briefing({
        staffYesterday: {
          summary: '', done: 0, total: 8,
          lowPerformers: [{ name: 'Eyafi', pct: 0, daysLow: 5 }, { name: 'Mustahid', pct: 10, daysLow: 4 }],
        },
        staffPatterns: [{ name: 'Eyafi', type: 'late', detail: 'রোজ দেরি' }],
      }),
    )
    expect(sigs).toHaveLength(0)
  })

  it('watches the ad account: a campaign whose performance dropped becomes a plan', () => {
    const sigs = selectDrivableSignals(
      briefing({
        adsDigest: { campaigns: [], anomalies: [{ campaign: 'Eid Panjabi', dropPct: 45 }] },
      }),
    )
    expect(sigs).toHaveLength(1)
    expect(sigs[0].area).toBe('ads')
    expect(sigs[0].signalKey).toBe('ads:Eid Panjabi')
  })

  it('flags a real sales drop against the 7-day average, and ignores normal wobble', () => {
    const dropped = selectDrivableSignals(
      briefing({ sales: { yesterdayTotal: 20_000, yesterdayOrders: 4, sevenDayAvg: 50_000, sevenDayOrderAvg: 10 } }),
    )
    expect(dropped.map((s) => s.signalKey)).toEqual(['business:sales_drop'])

    const normal = selectDrivableSignals(
      briefing({ sales: { yesterdayTotal: 46_000, yesterdayOrders: 9, sevenDayAvg: 50_000, sevenDayOrderAvg: 10 } }),
    )
    expect(normal).toHaveLength(0)
  })
})

describe('scanSignalsToPlanDrive — dedup, throttle, enrollment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPlanner.createPlan.mockImplementation(async ({ goal }: { goal: string }) => ({ id: `plan_${goal.slice(0, 4)}`, goal }))
    mockPlanner.enrollPlanForAutodrive.mockResolvedValue(undefined)
    mockPrisma.agentKvSetting.upsert.mockResolvedValue({})
    mockBriefing.buildOwnerBriefingData.mockResolvedValue(
      briefing({ reorderSuggestions: [{ id: 'FM-133', name: '133 সেট', suggestedQty: 20, urgency: 'high', reason: 'low', currentStock: 1, dailyRate: 1, daysOfStock: 1 }] }),
    )
  })

  it('creates a plan and enrolls it for a fresh signal', async () => {
    mockPrisma.agentKvSetting.findUnique.mockResolvedValue(null) // throttle absent + no active plan
    const res = await scanSignalsToPlanDrive({ now: new Date('2026-06-29T10:00:00Z') })
    expect(res.created).toHaveLength(1)
    expect(res.created[0].signalKey).toBe('stock:FM-133')
    expect(mockPlanner.createPlan).toHaveBeenCalledTimes(1)
    expect(mockPlanner.enrollPlanForAutodrive).toHaveBeenCalledTimes(1)
    // active-link KV written so the next scan dedups
    expect(mockPrisma.agentKvSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: 'signaldrive_active:ALMA_LIFESTYLE:stock:FM-133' } }),
    )
  })

  it('does NOT create a duplicate when an active plan already pursues the signal', async () => {
    // last-scan absent (throttle ok); active-link present; plan still driving.
    mockPrisma.agentKvSetting.findUnique.mockImplementation(({ where }: { where: { key: string } }) =>
      where.key === 'signaldrive_last_scan'
        ? Promise.resolve(null)
        : Promise.resolve({ value: 'plan_existing' }),
    )
    mockPrisma.agentPlan.findUnique.mockResolvedValue({ autodriveState: 'driving' })

    const res = await scanSignalsToPlanDrive({ now: new Date('2026-06-29T10:00:00Z') })
    expect(res.created).toHaveLength(0)
    expect(mockPlanner.createPlan).not.toHaveBeenCalled()
  })

  it('re-creates a plan when the previous one is terminal (signal recurred)', async () => {
    mockPrisma.agentKvSetting.findUnique.mockImplementation(({ where }: { where: { key: string } }) =>
      where.key === 'signaldrive_last_scan'
        ? Promise.resolve(null)
        : Promise.resolve({ value: 'plan_old' }),
    )
    mockPrisma.agentPlan.findUnique.mockResolvedValue({ autodriveState: 'done' }) // terminal

    const res = await scanSignalsToPlanDrive({ now: new Date('2026-06-29T10:00:00Z') })
    expect(res.created).toHaveLength(1)
    expect(mockPlanner.createPlan).toHaveBeenCalledTimes(1)
  })

  it('skips entirely (no briefing build) when throttled', async () => {
    const now = new Date('2026-06-29T10:00:00Z')
    const recent = new Date(now.getTime() - (SIGNAL_SCAN_INTERVAL_MIN - 5) * 60_000).toISOString()
    mockPrisma.agentKvSetting.findUnique.mockResolvedValue({ value: recent })

    const res = await scanSignalsToPlanDrive({ now })
    expect(res.skipped).toBe(true)
    expect(res.reason).toBe('throttled')
    expect(mockBriefing.buildOwnerBriefingData).not.toHaveBeenCalled()
  })

  it('force bypasses the throttle but still dedups', async () => {
    const now = new Date('2026-06-29T10:00:00Z')
    const recent = new Date(now.getTime() - 60_000).toISOString()
    // last-scan recent (would throttle); active-link absent.
    mockPrisma.agentKvSetting.findUnique.mockImplementation(({ where }: { where: { key: string } }) =>
      where.key === 'signaldrive_last_scan' ? Promise.resolve({ value: recent }) : Promise.resolve(null),
    )

    const res = await scanSignalsToPlanDrive({ now, force: true })
    expect(res.skipped).toBeUndefined()
    expect(res.created).toHaveLength(1)
    expect(mockBriefing.buildOwnerBriefingData).toHaveBeenCalledTimes(1)
  })
})
