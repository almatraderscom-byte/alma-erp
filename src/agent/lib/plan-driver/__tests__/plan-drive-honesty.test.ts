/**
 * G1 (owner ruling 2026-07-26) — the panel must never call a parked plan
 * "Running".
 *
 * What he saw on his phone: "Running 2". What the API said about the same two
 * plans: escalated, nextTickAt null, one step done, untouched for an hour. The
 * screen was the only thing still claiming they were working.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const mockPrisma = vi.hoisted(() => ({
  agentFindingSet: { findFirst: vi.fn().mockResolvedValue(null) },
  agentConversation: { findMany: vi.fn().mockResolvedValue([]) },
  agentPendingAction: { findMany: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

const planner = vi.hoisted(() => ({
  loadVisiblePlanDrives: vi.fn(),
  loadFinishedPlanDrives: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/agent/lib/planner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/lib/planner')>()
  return { ...actual, ...planner }
})

vi.mock('@/agent/lib/autodrive-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/lib/autodrive-config')>()
  return {
    ...actual,
    getAutodriveConfig: vi.fn().mockResolvedValue({
      enabled: true, dailyCapTaka: 200, planCapTaka: 50, maxAttempts: 5, batchSize: 10,
      gateModel: 'g', driverModel: 'd', backoffMin: 3, autoRepair: true, maxRepairSteps: 2,
    }),
  }
})

import { getPlanDrivePanel } from '@/agent/lib/plan-driver/plan-drive-view'

const step = (over: Record<string, unknown> = {}) => ({
  id: 's1', action: 'কারণ বের করো', dependsOn: [], status: 'done',
  attemptCount: 0, maxAttempts: 3, ...over,
})

const plan = (over: Record<string, unknown> = {}) => ({
  id: 'p1', goal: 'গতকালের সেল কম — কারণ বের করো', status: 'executing',
  conversationId: 'c1', businessId: 'ALMA_LIFESTYLE',
  steps: [step()], autodriveState: 'driving', attemptCount: 1, maxAttempts: 5,
  costTaka: 5, costMilliTaka: 5000, costMilliTakaDay: 5000,
  lastDrivenAt: new Date(Date.now() - 60 * 60_000), // an hour ago
  ...over,
})

beforeEach(() => vi.clearAllMocks())

describe('Plan-Drive panel honesty', () => {
  it('an escalated plan with no next tick is NOT running', async () => {
    planner.loadVisiblePlanDrives.mockResolvedValue([
      plan({ autodriveState: 'escalated', nextTickAt: null, selfCheckNote: 'যাচাই: করণীয় ঠিক হয়নি' }),
    ])

    const panel = await getPlanDrivePanel()

    expect(panel.drives[0].isRunning).toBe(false)
    expect(panel.runningCount).toBe(0)
    expect(panel.drives[0].statusLabel).toBe('আপনার সিদ্ধান্ত দরকার')
    expect(panel.needsDecisionCount).toBe(1)
    // …and it says how long it has been silent, so an hour of nothing is visible.
    expect(panel.drives[0].idleMs).toBeGreaterThan(59 * 60_000)
  })

  it('a plan with a step actually executing IS running, and names the step', async () => {
    planner.loadVisiblePlanDrives.mockResolvedValue([
      plan({ steps: [step({ status: 'running', action: 'অ্যাড ডেটা দেখছি' })], nextTickAt: new Date() }),
    ])

    const panel = await getPlanDrivePanel()

    expect(panel.drives[0].isRunning).toBe(true)
    expect(panel.runningCount).toBe(1)
    expect(panel.drives[0].statusLabel).toBe('চলছে')
    expect(panel.drives[0].runningStep).toBe('অ্যাড ডেটা দেখছি')
  })

  it('a driving plan with a scheduled next tick counts as running', async () => {
    planner.loadVisiblePlanDrives.mockResolvedValue([
      plan({ nextTickAt: new Date(Date.now() + 3 * 60_000) }),
    ])
    const panel = await getPlanDrivePanel()
    expect(panel.drives[0].isRunning).toBe(true)
  })

  // Owner report 2026-07-26: iOS listed these plans, web showed nothing. S0 gave
  // agent-started plans their own thread, and the web filter matched on chat id.
  it('marks agent-started plans autonomous so any chat can show them', async () => {
    mockPrisma.agentConversation.findMany.mockResolvedValue([{ id: 'c1' }]) // a drive thread
    planner.loadVisiblePlanDrives.mockResolvedValue([plan({ conversationId: 'c1' })])

    const panel = await getPlanDrivePanel()
    expect(panel.drives[0].isAutonomous).toBe(true)
  })

  it('a plan started from Boss own chat is NOT autonomous', async () => {
    mockPrisma.agentConversation.findMany.mockResolvedValue([]) // not a drive thread
    planner.loadVisiblePlanDrives.mockResolvedValue([plan({ conversationId: 'owner-chat' })])

    const panel = await getPlanDrivePanel()
    expect(panel.drives[0].isAutonomous).toBe(false)
  })

  it('a plan waiting on an approval is counted separately, not as running', async () => {
    planner.loadVisiblePlanDrives.mockResolvedValue([
      plan({ autodriveState: 'blocked', selfCheckNote: 'অনুমোদনের অপেক্ষায়: টাকা খরচ' }),
    ])

    const panel = await getPlanDrivePanel()

    expect(panel.drives[0].isRunning).toBe(false)
    expect(panel.drives[0].statusLabel).toBe('অনুমোদনের অপেক্ষায়')
    expect(panel.waitingApprovalCount).toBe(1)
    expect(panel.runningCount).toBe(0)
  })
})
