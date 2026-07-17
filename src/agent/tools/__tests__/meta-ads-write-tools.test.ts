import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Meta Ads MCP write tools (Phase MA3) — money-touching, so the tests lock the
 * safety contract: triple-gated (kill switch + connection + write tier), budget
 * guardrail refuses over-cap, every create stages a PAUSED approval card, and
 * ads_activate_entity (the spend switch) is its own before_execute card. None of
 * them touch Meta directly — they only stage a pending action.
 */

const enabledMock = vi.fn(async () => true)
const connectionMock = vi.fn(async (): Promise<Record<string, unknown> | null> => ({ access_token: 't' }))
const tierMock = vi.fn(async () => 'write' as 'read' | 'write' | 'financial')
const maxBudgetMock = vi.fn(async () => 20)
vi.mock('@/agent/lib/meta-mcp/oauth', () => ({
  isMetaMcpEnabled: () => enabledMock(),
  isMetaMcpEnvEnabled: () => true,
  getMetaMcpConnection: () => connectionMock(),
  getMetaMcpScopeTier: () => tierMock(),
  getMetaMcpMaxDailyBudget: () => maxBudgetMock(),
}))

const created: Array<{ type: string; payload: unknown; summary: string; status: string }> = []
const findFirstMock = vi.fn(async (): Promise<{ id: string } | null> => null)
vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentPendingAction: {
      create: vi.fn(async ({ data }: { data: { type: string; payload: unknown; summary: string; status: string } }) => {
        created.push(data)
        return { id: `pa_${created.length}`, ...data }
      }),
      findFirst: (...a: unknown[]) => findFirstMock(...(a as [])),
    },
  },
}))

import { META_ADS_WRITE_TOOLS, META_MCP_WRITE_TOOL_NAMES } from '../meta-ads-write-tools'

const byName = (n: string) => META_ADS_WRITE_TOOLS.find((t) => t.name === n)!

beforeEach(() => {
  enabledMock.mockResolvedValue(true)
  connectionMock.mockResolvedValue({ access_token: 't' })
  tierMock.mockResolvedValue('write')
  maxBudgetMock.mockResolvedValue(20)
  findFirstMock.mockResolvedValue(null)
  created.length = 0
})

describe('registration', () => {
  it('registers exactly the 6 write tools with the meta_ads_ prefix', () => {
    expect(META_ADS_WRITE_TOOLS.map((t) => t.name).sort()).toEqual([
      'meta_ads_activate_entity',
      'meta_ads_catalog_create',
      'meta_ads_create_ad',
      'meta_ads_create_ad_set',
      'meta_ads_create_campaign',
      'meta_ads_update_entity',
    ])
    expect(META_MCP_WRITE_TOOL_NAMES).toHaveLength(6)
  })
})

describe('triple gate', () => {
  it('kill switch off → refuses, no card staged', async () => {
    enabledMock.mockResolvedValue(false)
    const r = await byName('meta_ads_create_campaign').handler({ args: { objective: 'X' } })
    expect(r.success).toBe(false)
    expect(r.error).toContain('বন্ধ')
    expect(created).toHaveLength(0)
  })

  it('not connected → refuses with Connect instruction', async () => {
    connectionMock.mockResolvedValue(null)
    const r = await byName('meta_ads_create_campaign').handler({ args: {} })
    expect(r.success).toBe(false)
    expect(r.error).toContain('Connect')
    expect(created).toHaveLength(0)
  })

  it('read tier → refuses every write tool (defense in depth)', async () => {
    tierMock.mockResolvedValue('read')
    for (const t of META_ADS_WRITE_TOOLS) {
      const r = await t.handler({ args: {} })
      expect(r.success, t.name).toBe(false)
      expect(r.errorCode).toBe('auth')
    }
    expect(created).toHaveLength(0)
  })
})

describe('budget guardrail', () => {
  it('refuses an ad set daily_budget over the cap (minor-unit)', async () => {
    // cap 20; daily_budget 5000 cents = $50 > $20
    const r = await byName('meta_ads_create_ad_set').handler({ args: { daily_budget: 5000, campaign_id: 'c1' } })
    expect(r.success).toBe(false)
    expect(r.error).toContain('সর্বোচ্চ দৈনিক বাজেট')
    expect(created).toHaveLength(0)
  })

  it('allows a budget at/under the cap and stages the card', async () => {
    // 1500 cents = $15 ≤ $20
    const r = await byName('meta_ads_create_ad_set').handler({ args: { daily_budget: 1500, campaign_id: 'c1' } })
    expect(r.success).toBe(true)
    expect(created).toHaveLength(1)
    expect(created[0].type).toBe('meta_ads:ads_create_ad_set')
  })
})

describe('staging (PAUSED create) + activation (spend switch)', () => {
  it('create_campaign stages a PAUSED card, forwards args verbatim', async () => {
    const r = await byName('meta_ads_create_campaign').handler({ args: { name: 'Eid', objective: 'OUTCOME_ENGAGEMENT' }, conversationId: 'conv1' })
    expect(r.success).toBe(true)
    expect(created[0].type).toBe('meta_ads:ads_create_campaign')
    expect(created[0].summary).toContain('PAUSED')
    expect((created[0].payload as { remoteName: string; args: unknown }).remoteName).toBe('ads_create_campaign')
    expect((created[0].payload as { args: { objective: string } }).args.objective).toBe('OUTCOME_ENGAGEMENT')
  })

  it('activate_entity is a SEPARATE before_execute card with a red money warning', async () => {
    const r = await byName('meta_ads_activate_entity').handler({ args: { id: '123' } })
    expect(r.success).toBe(true)
    expect(created[0].type).toBe('meta_ads:ads_activate_entity')
    expect(created[0].summary).toContain('🔴')
    expect(created[0].summary).toContain('খরচ শুরু')
  })

  it('update_entity warns (does not block) when the same entity was edited in 24h', async () => {
    findFirstMock.mockResolvedValue({ id: 'prev' })
    const r = await byName('meta_ads_update_entity').handler({ args: { id: 'e9', daily_budget: 500 } })
    expect(r.success).toBe(true) // warn, not block
    expect(created[0].summary).toContain('learning')
  })
})
