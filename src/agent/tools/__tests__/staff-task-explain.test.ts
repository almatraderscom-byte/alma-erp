import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock prisma BEFORE importing the module under test. vi.hoisted keeps the mock
// object reachable from the hoisted vi.mock factory (static import triggers it).
const mockPrisma = vi.hoisted(() => ({
  agentStaffTask: { findUnique: vi.fn(), update: vi.fn() },
  agentPendingAction: { create: vi.fn() },
}))
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

// Gemini text is dynamically imported inside buildStaffTaskExplanation. Mock it so
// no network call happens and we control the explanation text.
const mockGemini = vi.hoisted(() => ({ geminiGenerateText: vi.fn() }))
vi.mock('@/agent/lib/gemini-text', () => mockGemini)

import { STAFF_TOOLS } from '@/agent/tools/staff-tools'

function explainHandler() {
  const tool = STAFF_TOOLS.find((t) => t.name === 'explain_staff_task_bangla')
  if (!tool) throw new Error('explain_staff_task_bangla not found')
  return tool.handler
}

const baseTask = {
  id: 't1',
  title: '5টি পেন্ডিং অর্ডার ফলো-আপ',
  detail: null,
  type: 'order_followup',
  productRef: null,
  status: 'proposed',
  businessId: 'ALMA_LIFESTYLE',
  staff: { id: 's1', name: 'Eyafi' },
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.agentStaffTask.update.mockResolvedValue({})
  mockGemini.geminiGenerateText.mockResolvedValue(
    'ERP খুলে pending অর্ডার দেখুন।\nকাস্টমারকে কল করে কনফার্ম নিন।\nশেষে status আপডেট করে Done দিন।',
  )
})

describe('explain_staff_task_bangla — folds explanation into task detail (no cards)', () => {
  it('writes the explanation straight into task.detail and creates NO approval card', async () => {
    mockPrisma.agentStaffTask.findUnique.mockResolvedValue(baseTask)

    const res = await explainHandler()({ taskId: 't1', businessId: 'ALMA_LIFESTYLE' })

    expect(res.success).toBe(true)
    // The historic "16 cards" bug: this tool must NEVER create a pending approval card.
    expect(mockPrisma.agentPendingAction.create).not.toHaveBeenCalled()
    // The explanation rides WITH the task — persisted into detail.
    expect(mockPrisma.agentStaffTask.update).toHaveBeenCalledTimes(1)
    const updateArg = mockPrisma.agentStaffTask.update.mock.calls[0][0]
    expect(updateArg.where).toEqual({ id: 't1' })
    expect(updateArg.data.detail).toContain('ERP')
    // No pendingActionId in the result → chat route emits no confirm_card.
    expect(res.data).not.toHaveProperty('pendingActionId')
    const data = res.data as Record<string, unknown>
    expect(data.ridesWithTask).toBe(true)
    expect(data.explainedCount).toBe(1)
  })

  it('explains MANY tasks in one call — one update each, still zero cards', async () => {
    mockPrisma.agentStaffTask.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve({ ...baseTask, id: where.id }),
    )

    const res = await explainHandler()({
      taskIds: ['t1', 't2', 't3'],
      businessId: 'ALMA_LIFESTYLE',
    })

    expect(res.success).toBe(true)
    expect((res.data as Record<string, unknown>).explainedCount).toBe(3)
    expect(mockPrisma.agentStaffTask.update).toHaveBeenCalledTimes(3)
    expect(mockPrisma.agentPendingAction.create).not.toHaveBeenCalled()
  })

  it('persists a detail that SURVIVES dispatch regeneration even if Gemini omits the tool', async () => {
    // Gemini returns prose with no tool keyword — makeDispatchSafeDetail must inject one
    // so staff-dispatch-sync.buildStaffFriendlyDetail preserves it instead of overwriting.
    mockGemini.geminiGenerateText.mockResolvedValue('কাস্টমারকে কল করুন।\nকনফার্ম করে নিন।')
    mockPrisma.agentStaffTask.findUnique.mockResolvedValue(baseTask)

    await explainHandler()({ taskId: 't1', businessId: 'ALMA_LIFESTYLE' })

    const savedDetail: string = mockPrisma.agentStaffTask.update.mock.calls[0][0].data.detail
    const lineCount = savedDetail.split('\n').filter(Boolean).length
    expect(lineCount).toBeGreaterThanOrEqual(2)
    expect(lineCount).toBeLessThanOrEqual(4)
    // order_followup tool hint is "ERP + ফোন/মেসেঞ্জার" → ERP keyword must appear.
    expect(savedDetail.toLowerCase()).toContain('erp')
  })

  it('skips a task from a different business and reports it (no cross-business write)', async () => {
    mockPrisma.agentStaffTask.findUnique.mockResolvedValue({
      ...baseTask,
      businessId: 'ALMA_TRADING',
    })

    const res = await explainHandler()({ taskId: 't1', businessId: 'ALMA_LIFESTYLE' })

    expect(res.success).toBe(true)
    const data = res.data as Record<string, unknown>
    expect(data.explainedCount).toBe(0)
    expect(data.skippedCount).toBe(1)
    expect(mockPrisma.agentStaffTask.update).not.toHaveBeenCalled()
  })

  it('errors when no task id is given', async () => {
    const res = await explainHandler()({ businessId: 'ALMA_LIFESTYLE' })
    expect(res.success).toBe(false)
    expect(mockPrisma.agentStaffTask.findUnique).not.toHaveBeenCalled()
  })

  it('does NOT save a Gemini explanation that swaps in a WRONG product code', async () => {
    // Bug: cheap model writes a different code (145) than the task's product (133),
    // confusing staff. Guard must reject it and fall back to the template (which uses 133).
    mockGemini.geminiGenerateText.mockResolvedValue(
      'Canva খুলে square অ্যাড বানান।\nপ্রোডাক্ট কোড 145 এর জন্য ছবি দিন।\nExport করে Done দিন।',
    )
    mockPrisma.agentStaffTask.findUnique.mockResolvedValue({
      ...baseTask,
      type: 'ad_creative',
      productRef: '133',
    })

    await explainHandler()({ taskId: 't1', businessId: 'ALMA_LIFESTYLE' })

    const savedDetail: string = mockPrisma.agentStaffTask.update.mock.calls[0][0].data.detail
    expect(savedDetail).toContain('133')
    expect(savedDetail).not.toContain('145')
  })

  it('keeps a Gemini explanation that uses the CORRECT product code', async () => {
    mockGemini.geminiGenerateText.mockResolvedValue(
      'Canva খুলে square অ্যাড বানান।\nপ্রোডাক্ট 133 ভালো করে দেখান।\nExport করে Done দিন।',
    )
    mockPrisma.agentStaffTask.findUnique.mockResolvedValue({
      ...baseTask,
      type: 'ad_creative',
      productRef: '133',
    })

    await explainHandler()({ taskId: 't1', businessId: 'ALMA_LIFESTYLE' })

    const savedDetail: string = mockPrisma.agentStaffTask.update.mock.calls[0][0].data.detail
    expect(savedDetail).toContain('133')
    expect(savedDetail.toLowerCase()).toContain('canva')
  })
})

describe('productCodeMismatch — code-integrity guard', () => {
  it('flags when a code-like productRef is absent from the text', async () => {
    const { productCodeMismatch } = await import('@/agent/tools/staff-tools')
    expect(productCodeMismatch('133', 'প্রোডাক্ট 145 এর ছবি দিন')).toBe(true)
  })
  it('passes when the exact code is present', async () => {
    const { productCodeMismatch } = await import('@/agent/tools/staff-tools')
    expect(productCodeMismatch('133', 'প্রোডাক্ট 133 ভালো দেখান')).toBe(false)
  })
  it('ignores non-code product names (full names never trigger fallback)', async () => {
    const { productCodeMismatch } = await import('@/agent/tools/staff-tools')
    expect(productCodeMismatch('Premium Panjabi', 'একটা সুন্দর অ্যাড বানান')).toBe(false)
  })
  it('is not satisfied by a longer number containing the code', async () => {
    const { productCodeMismatch } = await import('@/agent/tools/staff-tools')
    expect(productCodeMismatch('133', 'সাইজ 1337 দেখান')).toBe(true)
  })
})
