import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockPrisma = {
  agentGrowthBrief: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  agentKvSetting: {
    findUnique: vi.fn(),
  },
}
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

beforeEach(() => vi.clearAllMocks())

import type { GrowthBriefContent } from '@/agent/lib/marketing/growth-brief'

const completeContent = (): GrowthBriefContent => ({
  goals: [{ kind: 'decision', text: 'মাসে ১০০ delivered order' }],
  products: {
    focus: [{ name: 'Kids Panjabi', availability: 'in_stock', marginPctOfPrice: 35 }],
  },
  economics: { monthlyBudgetCapBdt: 30000, targetCpaBdt: 250.4 },
  customers: { segments: [{ name: 'young parents', language: 'bn' }] },
  objective: 'confirmed COD orders',
  measurementPlan: 'weekly funnel report + delivered profit vs spend',
})

describe('validateBriefForPlanning', () => {
  it('accepts a complete brief', async () => {
    const { validateBriefForPlanning } = await import('@/agent/lib/marketing/growth-brief')
    expect(validateBriefForPlanning(completeContent())).toEqual({ ok: true, missing: [] })
  })

  it('null brief → everything missing', async () => {
    const { validateBriefForPlanning } = await import('@/agent/lib/marketing/growth-brief')
    const v = validateBriefForPlanning(null)
    expect(v.ok).toBe(false)
    expect(v.missing).toEqual(['brief'])
  })

  it('flags each missing planning requirement', async () => {
    const { validateBriefForPlanning } = await import('@/agent/lib/marketing/growth-brief')
    const c = completeContent()
    c.products.focus = [{ name: 'X', availability: 'out' }]
    c.economics = { monthlyBudgetCapBdt: null }
    c.customers.segments = []
    c.objective = ''
    c.measurementPlan = null
    const v = validateBriefForPlanning(c)
    expect(v.ok).toBe(false)
    expect(v.missing.join(' | ')).toContain('product availability')
    expect(v.missing.join(' | ')).toContain('margin/profit constraint')
    expect(v.missing.join(' | ')).toContain('target customer segment')
    expect(v.missing.join(' | ')).toContain('objective')
    expect(v.missing.join(' | ')).toContain('measurement plan')
    expect(v.missing.join(' | ')).toContain('budget boundary')
  })

  it('zero/negative budget cap is not an approved boundary', async () => {
    const { validateBriefForPlanning } = await import('@/agent/lib/marketing/growth-brief')
    const c = completeContent()
    c.economics.monthlyBudgetCapBdt = 0
    expect(validateBriefForPlanning(c).ok).toBe(false)
  })
})

describe('createDraftBrief — versioning', () => {
  it('first draft is v1, no changeReason needed; money normalized to whole taka', async () => {
    const { createDraftBrief } = await import('@/agent/lib/marketing/growth-brief')
    mockPrisma.agentGrowthBrief.findFirst.mockResolvedValue(null)
    mockPrisma.agentGrowthBrief.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'b1', ...data }))

    const row = await createDraftBrief({ content: completeContent() })
    expect(row.version).toBe(1)
    const saved = mockPrisma.agentGrowthBrief.create.mock.calls[0][0].data
    expect(saved.brief.economics.targetCpaBdt).toBe(250) // 250.4 → whole taka
    expect(saved.status).toBe('draft')
  })

  it('v2+ without changeReason throws (history must explain itself)', async () => {
    const { createDraftBrief } = await import('@/agent/lib/marketing/growth-brief')
    mockPrisma.agentGrowthBrief.findFirst.mockResolvedValue({ version: 3 })
    await expect(createDraftBrief({ content: completeContent() })).rejects.toThrow(/changeReason/)
    expect(mockPrisma.agentGrowthBrief.create).not.toHaveBeenCalled()
  })

  it('v2 with changeReason increments version', async () => {
    const { createDraftBrief } = await import('@/agent/lib/marketing/growth-brief')
    mockPrisma.agentGrowthBrief.findFirst.mockResolvedValue({ version: 1 })
    mockPrisma.agentGrowthBrief.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'b2', ...data }))
    const row = await createDraftBrief({ content: completeContent(), changeReason: 'Eid season pivot' })
    expect(row.version).toBe(2)
    expect(mockPrisma.agentGrowthBrief.create.mock.calls[0][0].data.changeReason).toBe('Eid season pivot')
  })
})

describe('approveBrief', () => {
  it('freezes draft, supersedes previous approved (history preserved, not deleted)', async () => {
    const { approveBrief } = await import('@/agent/lib/marketing/growth-brief')
    mockPrisma.agentGrowthBrief.findUnique.mockResolvedValue({
      id: 'b2', businessId: 'ALMA_LIFESTYLE', status: 'draft', brief: completeContent(),
    })
    mockPrisma.agentGrowthBrief.updateMany.mockResolvedValue({ count: 1 })
    mockPrisma.agentGrowthBrief.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'b2', version: 2, ...data }))

    const row = await approveBrief('b2', 'owner')
    expect(row.status).toBe('approved')
    // Previous approved version superseded — never deleted.
    expect(mockPrisma.agentGrowthBrief.updateMany).toHaveBeenCalledWith({
      where: { businessId: 'ALMA_LIFESTYLE', status: 'approved' },
      data: { status: 'superseded' },
    })
  })

  it('refuses to approve an incomplete brief', async () => {
    const { approveBrief } = await import('@/agent/lib/marketing/growth-brief')
    const incomplete = completeContent()
    incomplete.objective = null
    mockPrisma.agentGrowthBrief.findUnique.mockResolvedValue({ id: 'b3', businessId: 'ALMA_LIFESTYLE', status: 'draft', brief: incomplete })
    await expect(approveBrief('b3')).rejects.toThrow(/incomplete/i)
    expect(mockPrisma.agentGrowthBrief.update).not.toHaveBeenCalled()
  })

  it('approving an already-approved brief is idempotent', async () => {
    const { approveBrief } = await import('@/agent/lib/marketing/growth-brief')
    const row = { id: 'b4', businessId: 'ALMA_LIFESTYLE', status: 'approved', brief: completeContent() }
    mockPrisma.agentGrowthBrief.findUnique.mockResolvedValue(row)
    await expect(approveBrief('b4')).resolves.toBe(row)
    expect(mockPrisma.agentGrowthBrief.updateMany).not.toHaveBeenCalled()
  })
})

describe('getPlanningAuthority — the plan gate', () => {
  it('blocks planning with Bangla guidance when no approved brief', async () => {
    const { getPlanningAuthority } = await import('@/agent/lib/marketing/growth-brief')
    mockPrisma.agentKvSetting.findUnique.mockResolvedValue(null)
    mockPrisma.agentGrowthBrief.findFirst.mockResolvedValue(null)
    const auth = await getPlanningAuthority()
    expect(auth.allowed).toBe(false)
    expect(auth.ownerMessage).toContain('Growth Brief')
  })

  it('allows planning with a complete approved brief', async () => {
    const { getPlanningAuthority } = await import('@/agent/lib/marketing/growth-brief')
    mockPrisma.agentKvSetting.findUnique.mockResolvedValue(null)
    mockPrisma.agentGrowthBrief.findFirst.mockResolvedValue({ id: 'b1', status: 'approved', brief: completeContent() })
    const auth = await getPlanningAuthority()
    expect(auth.allowed).toBe(true)
    expect(auth.missing).toEqual([])
  })

  it('kv growth.brief.enforce=false lets planning pass but still reports missing', async () => {
    const { getPlanningAuthority } = await import('@/agent/lib/marketing/growth-brief')
    mockPrisma.agentKvSetting.findUnique.mockResolvedValue({ value: 'false' })
    mockPrisma.agentGrowthBrief.findFirst.mockResolvedValue(null)
    const auth = await getPlanningAuthority()
    expect(auth.allowed).toBe(true)
    expect(auth.missing.length).toBeGreaterThan(0)
  })
})
