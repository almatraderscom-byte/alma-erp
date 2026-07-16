import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockPrisma = vi.hoisted(() => ({
  agentKvSetting: { create: vi.fn(), findUnique: vi.fn() },
  agentAuditLog: { create: vi.fn() },
  agentGrowthBrief: { findFirst: vi.fn() },
}))
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

const mockLaunch = vi.hoisted(() => vi.fn())
vi.mock('@/agent/lib/meta-ads', () => ({
  launchCampaign: mockLaunch,
}))

beforeEach(() => vi.clearAllMocks())

import {
  validateCampaignSpec,
  campaignIdempotencyKey,
  buildCampaignDiff,
  claimCampaignIdempotency,
  stageCampaign,
  type CampaignPlanSpec,
} from '@/agent/lib/marketing/meta-campaign-graph'

const spec = (over: Partial<CampaignPlanSpec> = {}): CampaignPlanSpec => ({
  experimentId: 'exp-1',
  objective: 'messenger_cod',
  name: 'Eid Panjabi CTM',
  dailyBudgetBdt: 500,
  message: 'বাবা-ছেলের ম্যাচিং সেট — Messenger-এ অর্ডার করুন',
  imageUrl: 'https://example.com/creative.jpg',
  utm: { utm_source: 'meta', utm_medium: 'paid_social', utm_campaign: 'alma_cod_orders_202607' },
  trackingQa: { pixelProven: true },
  ...over,
})

describe('validateCampaignSpec', () => {
  const cap = { monthlyBudgetCapBdt: 30000 }

  it('valid spec inside the brief cap passes with monthly projection', () => {
    const v = validateCampaignSpec(spec(), cap)
    expect(v.ok).toBe(true)
    expect(v.projectedMonthlyBdt).toBe(15000)
  })

  it('no experiment → rejected (campaign IS an experiment)', () => {
    const v = validateCampaignSpec(spec({ experimentId: '' }), cap)
    expect(v.errors.join()).toContain('experimentId')
  })

  it('over the approved budget boundary → rejected with exact numbers', () => {
    const v = validateCampaignSpec(spec({ dailyBudgetBdt: 2000 }), cap)
    expect(v.ok).toBe(false)
    expect(v.errors.join()).toContain('60000')
    expect(v.errors.join()).toContain('30000')
  })

  it('no approved boundary at all → rejected', () => {
    const v = validateCampaignSpec(spec(), { monthlyBudgetCapBdt: null })
    expect(v.errors.join()).toContain('budget boundary')
  })

  it('unsupported objectives named honestly, unknown ones flagged', () => {
    expect(validateCampaignSpec(spec({ objective: 'catalog_sales' }), cap).errors.join()).toContain('UNSUPPORTED')
    expect(validateCampaignSpec(spec({ objective: 'weird' }), cap).errors.join()).toContain('unknown objective')
  })

  it('bad UTM rejected; unproven pixel only warns', () => {
    const v = validateCampaignSpec(spec({ utm: { utm_source: 'facebook' } }), cap)
    expect(v.ok).toBe(false)
    const w = validateCampaignSpec(spec({ trackingQa: { pixelProven: false } }), cap)
    expect(w.ok).toBe(true)
    expect(w.warnings.join()).toContain('pixel')
  })
})

describe('idempotency — a retry can never create two campaigns', () => {
  it('same spec → same key; changed budget/name → different key', () => {
    const a = campaignIdempotencyKey(spec())
    expect(campaignIdempotencyKey(spec())).toBe(a)
    expect(campaignIdempotencyKey(spec({ dailyBudgetBdt: 600 }))).not.toBe(a)
    expect(campaignIdempotencyKey(spec({ name: 'other' }))).not.toBe(a)
  })

  it('first claim wins, second claim (unique violation) returns false', async () => {
    mockPrisma.agentKvSetting.create.mockResolvedValueOnce({})
    expect(await claimCampaignIdempotency('k1')).toBe(true)
    mockPrisma.agentKvSetting.create.mockRejectedValueOnce(new Error('Unique constraint failed'))
    expect(await claimCampaignIdempotency('k1')).toBe(false)
  })
})

describe('stageCampaign — validate → claim → create PAUSED → changelog', () => {
  const approvedBrief = {
    version: 2,
    brief: { economics: { monthlyBudgetCapBdt: 30000 } },
  }

  it('happy path stages a paused campaign and change-logs it', async () => {
    mockPrisma.agentGrowthBrief.findFirst.mockResolvedValue(approvedBrief)
    mockPrisma.agentKvSetting.create.mockResolvedValue({})
    mockLaunch.mockResolvedValue({ success: true, campaignId: 'c1', adSetId: 's1', adId: 'a1' })
    mockPrisma.agentAuditLog.create.mockResolvedValue({})

    const r = await stageCampaign(spec())
    expect(r).toMatchObject({ success: true, campaignId: 'c1' })
    expect(mockLaunch).toHaveBeenCalledOnce()
    const logged = mockPrisma.agentAuditLog.create.mock.calls[0][0].data
    expect(logged.actionType).toBe('meta_campaign_stage')
    expect(logged.payload.experimentId).toBe('exp-1')
    expect(logged.payload.pausedByDesign).toBe(true)
  })

  it('duplicate spec is blocked BEFORE any Graph write', async () => {
    mockPrisma.agentGrowthBrief.findFirst.mockResolvedValue(approvedBrief)
    mockPrisma.agentKvSetting.create.mockRejectedValue(new Error('Unique constraint failed'))

    const r = await stageCampaign(spec())
    expect(r.success).toBe(false)
    expect(r.deduped).toBe(true)
    expect(mockLaunch).not.toHaveBeenCalled()
  })

  it('invalid spec never reaches idempotency or Graph', async () => {
    mockPrisma.agentGrowthBrief.findFirst.mockResolvedValue(approvedBrief)
    const r = await stageCampaign(spec({ dailyBudgetBdt: 5000 }))
    expect(r.success).toBe(false)
    expect(mockPrisma.agentKvSetting.create).not.toHaveBeenCalled()
    expect(mockLaunch).not.toHaveBeenCalled()
  })

  it('launch failure is change-logged and surfaced', async () => {
    mockPrisma.agentGrowthBrief.findFirst.mockResolvedValue(approvedBrief)
    mockPrisma.agentKvSetting.create.mockResolvedValue({})
    mockLaunch.mockResolvedValue({ success: false, error: 'adimages 400: bad image' })

    const r = await stageCampaign(spec())
    expect(r.success).toBe(false)
    expect(r.error).toContain('adimages')
    expect(mockPrisma.agentAuditLog.create).toHaveBeenCalledOnce()
  })
})

describe('buildCampaignDiff', () => {
  it('diff shows budget, audience, tracking state and the PAUSED promise', () => {
    const s = spec()
    const v = validateCampaignSpec(s, { monthlyBudgetCapBdt: 30000 })
    const diff = buildCampaignDiff(s, v)
    expect(diff).toContain('PAUSED')
    expect(diff).toContain('৳500/দিন')
    expect(diff).toContain('exp-1')
    expect(diff).toContain('pixel proven')
  })
})
