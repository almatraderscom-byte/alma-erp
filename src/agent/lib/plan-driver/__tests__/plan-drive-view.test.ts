import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  loadVisible: vi.fn(),
  loadFinished: vi.fn(),
  config: vi.fn(),
}))

vi.mock('@/agent/lib/planner', () => ({
  loadVisiblePlanDrives: mocks.loadVisible,
  loadFinishedPlanDrives: mocks.loadFinished,
}))

vi.mock('@/agent/lib/autodrive-config', () => ({
  getAutodriveConfig: mocks.config,
}))

import { getPlanDrivePanel } from '@/agent/lib/plan-driver/plan-drive-view'

describe('Plan-Drive Background Tasks read model', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.config.mockResolvedValue({ enabled: true, dailyCapTaka: 100, planCapTaka: 25 })
  })

  it('keeps a stable start time for truthful live seconds', async () => {
    mocks.loadVisible.mockResolvedValue([{
      id: 'running-1', goal: 'Courier audit', status: 'executing', conversationId: 'c1',
      businessId: 'ALMA_LIFESTYLE', autodriveState: 'driving', attemptCount: 0,
      maxAttempts: 5, costTaka: 1, createdAt: new Date('2026-07-15T10:00:00.000Z'),
      lastDrivenAt: new Date('2026-07-15T10:00:28.000Z'),
      steps: [{ id: 's1', action: 'Check courier', dependsOn: [], status: 'running' }],
    }])
    mocks.loadFinished.mockResolvedValue([])

    const panel = await getPlanDrivePanel()

    expect(panel.drives[0].startedAt).toBe('2026-07-15T10:00:00.000Z')
    expect(panel.drives[0].lastDrivenAt).toBe('2026-07-15T10:00:28.000Z')
  })

  it('returns terminal task input, result, error, and completion status', async () => {
    mocks.loadVisible.mockResolvedValue([])
    mocks.loadFinished.mockResolvedValue([
      {
        id: 'done-1', goal: 'Owner briefing', status: 'done', conversationId: 'c1',
        businessId: 'ALMA_LIFESTYLE', autodriveState: 'done', attemptCount: 0,
        maxAttempts: 5, costTaka: 2, createdAt: new Date('2026-07-15T09:00:00.000Z'),
        completedAt: new Date('2026-07-15T09:02:00.000Z'),
        steps: [{ id: 's1', action: 'Verify data', dependsOn: [], status: 'done', result: 'Verified' }],
      },
      {
        id: 'failed-1', goal: 'Ads report', status: 'failed', conversationId: 'c1',
        businessId: 'ALMA_LIFESTYLE', autodriveState: 'failed', attemptCount: 3,
        maxAttempts: 3, costTaka: 0, createdAt: new Date('2026-07-15T08:00:00.000Z'),
        completedAt: new Date('2026-07-15T08:01:00.000Z'),
        steps: [{ id: 's2', action: 'Fetch ads', dependsOn: [], status: 'failed', error: 'Token expired' }],
      },
    ])

    const panel = await getPlanDrivePanel()

    expect(panel.finished[0]).toMatchObject({
      status: 'completed', input: 'Owner briefing', result: 'Verify data: Verified',
    })
    expect(panel.finished[1]).toMatchObject({
      status: 'failed', input: 'Ads report', error: 'Token expired',
    })
  })
})
