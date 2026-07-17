import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Meta Ads MCP bridge (Phase MA1) — guards the plan's safety contract:
 *   1. The capability map is EXHAUSTIVE for all 29 remote tools (plan §1) with
 *      the §2.2 mapping — reads free, writes staged, activate = before_execute.
 *   2. MA1 registers ONLY read tools (+ the discovery helper). No write tool
 *      wrapper exists at ANY tier — write registration is MA3's job.
 *   3. Kill switches + not-connected degrade with a clear Bangla message and
 *      never reach the network.
 *   4. Success path: original (unprefixed) name goes over the wire; the MCP
 *      envelope flattens into the ToolResult contract.
 */

const enabledMock = vi.fn(async () => true)
const envEnabledMock = vi.fn(() => true)
const connectionMock = vi.fn(async (): Promise<Record<string, unknown> | null> => ({ access_token: 't', tier: 'read' }))
const tierMock = vi.fn(async () => 'read' as const)
vi.mock('../oauth', () => ({
  isMetaMcpEnabled: () => enabledMock(),
  isMetaMcpEnvEnabled: () => envEnabledMock(),
  getMetaMcpConnection: () => connectionMock(),
  getMetaMcpScopeTier: () => tierMock(),
  // client.ts links against these too (it is import-mocked below, but the real
  // module still resolves its own imports at link time).
  getMetaMcpAccessToken: vi.fn(async () => 'tok'),
  getMetaMcpEndpoint: () => 'https://mcp.example.test/ads',
}))

const callToolMock = vi.fn()
const listToolsMock = vi.fn()
vi.mock('../client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    metaMcpCallTool: (...args: unknown[]) => callToolMock(...args),
    metaMcpListTools: (...args: unknown[]) => listToolsMock(...args),
  }
})

const kvFindUniqueMock = vi.fn(async (): Promise<{ value: string } | null> => null)
vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentKvSetting: {
      findUnique: (...args: unknown[]) => kvFindUniqueMock(...(args as [])),
      upsert: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({})),
    },
  },
}))

import {
  META_MCP_TOOL_CAPABILITIES,
  META_MCP_READ_TOOL_NAMES,
  META_MCP_WRITE_TOOL_NAMES,
  createMetaAdsReadTools,
  bridgedToolName,
  isRegisterableAtTier,
} from '../bridge'

// The full 29-tool inventory from the plan (§1) — names as Meta's server exposes them.
const PLAN_INVENTORY = [
  // Campaign (5)
  'ads_create_campaign', 'ads_create_ad_set', 'ads_create_ad', 'ads_update_entity', 'ads_activate_entity',
  // Catalog (10)
  'ads_catalog_create', 'ads_catalog_get_catalogs', 'ads_catalog_get_details', 'ads_catalog_get_diagnostics',
  'ads_catalog_get_feed_rules', 'ads_catalog_get_product_details', 'ads_catalog_get_product_feed_details',
  'ads_catalog_get_product_set_products', 'ads_catalog_get_product_sets', 'ads_catalog_get_products',
  // Accounts (3)
  'ads_get_ad_accounts', 'ads_get_ad_entities', 'ads_get_pages_for_business',
  // Dataset (4)
  'ads_get_dataset_details', 'ads_get_dataset_quality', 'ads_get_dataset_stats', 'ads_get_errors',
  // Insights (7)
  'ads_insights_advertiser_context', 'ads_insights_anomaly_signal', 'ads_insights_auction_ranking_benchmarks',
  'ads_insights_industry_benchmark', 'ads_insights_performance_trend', 'ads_get_opportunity_score',
  'ads_get_help_article',
]

const WRITE_TOOLS = [
  'ads_create_campaign', 'ads_create_ad_set', 'ads_create_ad', 'ads_update_entity', 'ads_activate_entity',
  'ads_catalog_create',
]

beforeEach(() => {
  enabledMock.mockResolvedValue(true)
  envEnabledMock.mockReturnValue(true)
  connectionMock.mockResolvedValue({ access_token: 't', tier: 'read' })
  tierMock.mockResolvedValue('read')
  callToolMock.mockReset()
  listToolsMock.mockReset()
  kvFindUniqueMock.mockResolvedValue(null)
})

describe('capability map (plan §2.2)', () => {
  it('is exhaustive for exactly the 29 plan-inventory tools', () => {
    expect(PLAN_INVENTORY).toHaveLength(29)
    expect(Object.keys(META_MCP_TOOL_CAPABILITIES).sort()).toEqual([...PLAN_INVENTORY].sort())
  })

  it('classifies every ads_get_/ads_insights_/ads_catalog_get_ tool as approval-free read', () => {
    for (const name of PLAN_INVENTORY.filter((n) => !WRITE_TOOLS.includes(n))) {
      expect(META_MCP_TOOL_CAPABILITIES[name], name).toMatchObject({ mode: 'read', approval: 'none', minTier: 'read' })
    }
    expect(META_MCP_READ_TOOL_NAMES).toHaveLength(23)
  })

  it('maps create/update writes to staged_card and activate to before_execute + high risk', () => {
    for (const name of WRITE_TOOLS.filter((n) => n !== 'ads_activate_entity')) {
      expect(META_MCP_TOOL_CAPABILITIES[name], name).toMatchObject({ approval: 'staged_card', minTier: 'write' })
    }
    expect(META_MCP_TOOL_CAPABILITIES.ads_activate_entity).toMatchObject({
      approval: 'before_execute',
      risk: 'high',
      minTier: 'write',
    })
    expect(META_MCP_WRITE_TOOL_NAMES.sort()).toEqual([...WRITE_TOOLS].sort())
  })
})

describe('MA1 registration (read tier)', () => {
  const tools = createMetaAdsReadTools()
  const names = tools.map((t) => t.name)

  it('registers all 23 read tools with the meta_ prefix + the discovery helper', () => {
    expect(names).toHaveLength(24)
    expect(names).toContain('meta_ads_list_tools')
    for (const original of META_MCP_READ_TOOL_NAMES) {
      expect(names).toContain(bridgedToolName(original))
    }
    // Plan §4 example spelling
    expect(names).toContain('meta_ads_insights_performance_trend')
  })

  it('registers NO write tool wrapper (write side is MA3)', () => {
    for (const w of WRITE_TOOLS) {
      expect(names).not.toContain(bridgedToolName(w))
    }
  })

  it('write tools are not registerable at read tier; reads always are (defense in depth)', () => {
    for (const w of WRITE_TOOLS) {
      expect(isRegisterableAtTier(w, 'read'), w).toBe(false)
      expect(isRegisterableAtTier(w, 'write'), w).toBe(true)
    }
    for (const r of META_MCP_READ_TOOL_NAMES) {
      expect(isRegisterableAtTier(r, 'read'), r).toBe(true)
    }
    expect(isRegisterableAtTier('ads_totally_unknown', 'financial')).toBe(false)
  })

  it('keeps the args envelope permissive under a strict root (Meta owns the real schema)', () => {
    const trend = tools.find((t) => t.name === 'meta_ads_insights_performance_trend')
    const schema = trend?.input_schema as { properties?: { args?: { type?: string; additionalProperties?: unknown } } }
    // Root gets additionalProperties:false via registry hardenToolSchemas; the
    // nested args object must stay free-form for verbatim passthrough.
    expect(schema.properties?.args).toMatchObject({ type: 'object', additionalProperties: true })
  })
})

describe('handler gating + degradation', () => {
  const trend = createMetaAdsReadTools().find((t) => t.name === 'meta_ads_insights_performance_trend')!

  it('kill switch off → Bangla disabled message, no network call', async () => {
    enabledMock.mockResolvedValue(false)
    envEnabledMock.mockReturnValue(false)
    const r = await trend.handler({})
    expect(r.success).toBe(false)
    expect(r.error).toContain('Meta Ads MCP বন্ধ')
    expect(callToolMock).not.toHaveBeenCalled()
    expect(listToolsMock).not.toHaveBeenCalled()
  })

  it('not connected → connect instruction, errorCode auth, no network call', async () => {
    connectionMock.mockResolvedValue(null)
    const r = await trend.handler({})
    expect(r.success).toBe(false)
    expect(r.errorCode).toBe('auth')
    expect(r.error).toContain('Connect Meta Ads')
    expect(callToolMock).not.toHaveBeenCalled()
  })

  it('remote tool vanished from a FRESH catalog → graceful not_found, no crash', async () => {
    kvFindUniqueMock.mockResolvedValue({
      value: JSON.stringify({ fetchedAt: new Date().toISOString(), tools: [{ name: 'ads_get_ad_accounts' }] }),
    })
    const r = await trend.handler({})
    expect(r.success).toBe(false)
    expect(r.errorCode).toBe('not_found')
    expect(callToolMock).not.toHaveBeenCalled()
  })
})

describe('handler success path', () => {
  const tools = createMetaAdsReadTools()
  const trend = tools.find((t) => t.name === 'meta_ads_insights_performance_trend')!

  function freshCatalogWith(...names: string[]) {
    kvFindUniqueMock.mockResolvedValue({
      value: JSON.stringify({ fetchedAt: new Date().toISOString(), tools: names.map((name) => ({ name })) }),
    })
  }

  it('calls the ORIGINAL (unprefixed) name, unwrapping the args envelope, and parses JSON text content', async () => {
    freshCatalogWith('ads_insights_performance_trend')
    callToolMock.mockResolvedValue({ content: [{ type: 'text', text: '{"ctr":1.2}' }], isError: false })
    const r = await trend.handler({ args: { date_preset: 'last_7d' } })
    expect(callToolMock).toHaveBeenCalledWith('ads_insights_performance_trend', { date_preset: 'last_7d' })
    expect(r).toMatchObject({ success: true, data: { ctr: 1.2 } })
  })

  it('tolerates flat args from non-validated callers', async () => {
    freshCatalogWith('ads_insights_performance_trend')
    callToolMock.mockResolvedValue({ content: [{ type: 'text', text: 'null' }] })
    await trend.handler({ date_preset: 'last_7d' })
    expect(callToolMock).toHaveBeenCalledWith('ads_insights_performance_trend', { date_preset: 'last_7d' })
  })

  it('prefers structuredContent and flags isError results as failures', async () => {
    freshCatalogWith('ads_insights_performance_trend')
    callToolMock.mockResolvedValue({ structuredContent: { rows: [1, 2] }, content: [] })
    const ok = await trend.handler({})
    expect(ok).toMatchObject({ success: true, data: { rows: [1, 2] } })

    callToolMock.mockResolvedValue({ content: [{ type: 'text', text: 'Error: no such account' }], isError: true })
    const bad = await trend.handler({})
    expect(bad.success).toBe(false)
    expect(bad.error).toContain('no such account')
  })

  it('meta_ads_list_tools returns the catalog with agent-tool mapping', async () => {
    freshCatalogWith('ads_insights_performance_trend', 'ads_create_campaign')
    const listTool = tools.find((t) => t.name === 'meta_ads_list_tools')!
    const r = await listTool.handler({})
    expect(r.success).toBe(true)
    const data = r.data as { count: number; tools: Array<{ remoteName: string; agentTool: string | null; available: boolean }> }
    expect(data.count).toBe(2)
    expect(data.tools.find((t) => t.remoteName === 'ads_insights_performance_trend')).toMatchObject({
      agentTool: 'meta_ads_insights_performance_trend',
      available: true,
    })
    // Write tool visible in the inventory but NOT callable via the agent at MA1.
    expect(data.tools.find((t) => t.remoteName === 'ads_create_campaign')).toMatchObject({
      agentTool: null,
      available: false,
    })
  })

  it('maps a typed client error onto the ToolResult envelope (retryable rate limit)', async () => {
    freshCatalogWith('ads_insights_performance_trend')
    const { MetaMcpError } = await import('../client')
    callToolMock.mockRejectedValue(new MetaMcpError('rate_limited', 'meta_mcp: HTTP 429'))
    const r = await trend.handler({})
    expect(r).toMatchObject({ success: false, errorCode: 'rate_limited', retryable: true })
  })
})
