import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock prisma BEFORE importing the module under test.
const mockPrisma = vi.hoisted(() => ({
  agentKvSetting: { findUnique: vi.fn() },
}))
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

import { shouldVerifyTaskType } from '@/agent/lib/task-verification'

beforeEach(() => {
  vi.clearAllMocks()
  // No KV rows configured → verification enabled, empty skip list (the defaults).
  mockPrisma.agentKvSetting.findUnique.mockResolvedValue(null)
})

describe('shouldVerifyTaskType Phase 2', () => {
  it('office_task is instant — no proof required', async () => {
    expect(await shouldVerifyTaskType('office_task')).toBe(false)
  })

  it('product_photo still requires proof', async () => {
    expect(await shouldVerifyTaskType('product_photo')).toBe(true)
  })

  it('instant-done types never touch the DB', async () => {
    await shouldVerifyTaskType('office_task')
    expect(mockPrisma.agentKvSetting.findUnique).not.toHaveBeenCalled()
  })
})
