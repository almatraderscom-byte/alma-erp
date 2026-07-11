/**
 * P5 weekly self-report — success-rate telemetry, checkpoint roll-up, and the
 * below-threshold flag ("flagged for playbook improvement, not silently
 * retried harder").
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const openTasks: Array<Record<string, unknown>> = []
const actions: Array<{ type: string; status: string }> = []

vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentOpenTask: {
      findMany: vi.fn(async () => openTasks),
    },
    agentPendingAction: {
      findMany: vi.fn(async () => actions),
    },
  },
}))

import { buildWeeklySelfReport, FLAG_THRESHOLD } from '@/agent/lib/self-report'

beforeEach(() => {
  openTasks.length = 0
  actions.length = 0
})

describe('buildWeeklySelfReport', () => {
  it('rolls up checkpoints (open vs resolved) and per-type success rates', async () => {
    openTasks.push(
      {
        title: '⛔ আটকে গেছে: crawl',
        status: 'open',
        checkpoint: { taskType: 'browser_action', error: 'timeout' },
        createdAt: new Date(),
      },
      {
        title: '⏸️ আপনার উত্তর দরকার: login',
        status: 'done',
        checkpoint: { taskType: 'browser_action' },
        createdAt: new Date(),
      },
    )
    actions.push(
      { type: 'workbench_run', status: 'executed' },
      { type: 'workbench_run', status: 'executed' },
      { type: 'workbench_run', status: 'failed' },
      { type: 'image_gen', status: 'executed' },
      { type: 'image_gen', status: 'pending' },
    )

    const r = await buildWeeklySelfReport(7)
    expect(r.checkpoints.total).toBe(2)
    expect(r.checkpoints.stillOpen).toBe(1)

    const wb = r.jobStats.find((s) => s.type === 'workbench_run')!
    expect(wb.executed).toBe(2)
    expect(wb.failed).toBe(1)
    expect(wb.successRate).toBeCloseTo(2 / 3)

    const img = r.jobStats.find((s) => s.type === 'image_gen')!
    expect(img.pending).toBe(1)
    expect(img.successRate).toBe(1) // one resolved, one pending

    expect(r.digestBn).toContain('সাপ্তাহিক সেলফ-রিপোর্ট')
    expect(r.digestBn).toContain('workbench_run')
  })

  it('flags a task type below threshold with enough runs — and only then', async () => {
    // 1/3 success = 33% < threshold, 3 resolved runs → flagged
    actions.push(
      { type: 'browser_action', status: 'failed' },
      { type: 'browser_action', status: 'failed' },
      { type: 'browser_action', status: 'executed' },
      // 1/2 = 50% but only 2 resolved runs → NOT flagged (not enough signal)
      { type: 'video_gen', status: 'failed' },
      { type: 'video_gen', status: 'executed' },
    )
    const r = await buildWeeklySelfReport(7)
    expect(r.flaggedTypes).toEqual(['browser_action'])
    expect(r.digestBn).toContain('দুর্বল কাজের ধরন')
    expect(FLAG_THRESHOLD).toBeGreaterThan(0.5)
  })

  it('a quiet week produces a clean digest, no flags', async () => {
    const r = await buildWeeklySelfReport(7)
    expect(r.checkpoints.total).toBe(0)
    expect(r.flaggedTypes).toEqual([])
    expect(r.digestBn).toContain('কোনো লম্বা কাজ চলেনি')
  })
})
