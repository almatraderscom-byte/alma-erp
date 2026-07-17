import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * MA2 insights source (plan §5) — MCP-preferred, Graph-fallback, and above all
 * STRUCTURALLY honest about which one produced the numbers.
 *
 * The incident this exists to prevent (2026-07-17): the head answered from the
 * Graph path while telling the owner "Meta MCP থেকে লাইভ চেক করে দেখলাম".
 * Here, provenance travels WITH the data — a caller cannot get numbers without
 * their true source.
 *
 * Kill-switch acceptance: with MCP off/disconnected/rollout-gated, the old path
 * still returns the same real campaign numbers — never an error, never a zero.
 */

const enabledMock = vi.fn(async () => true)
const connectionMock = vi.fn(async (): Promise<Record<string, unknown> | null> => ({ access_token: 't' }))
vi.mock('../oauth', () => ({
  isMetaMcpEnabled: () => enabledMock(),
  isMetaMcpEnvEnabled: () => true,
  getMetaMcpConnection: () => connectionMock(),
  getMetaMcpScopeTier: async () => 'read',
  getMetaMcpAccessToken: async () => 'tok',
  getMetaMcpEndpoint: () => 'https://mcp.example.test/ads',
}))

const callToolMock = vi.fn()
vi.mock('../client', () => ({
  metaMcpCallTool: (...a: unknown[]) => callToolMock(...a),
  metaMcpListTools: vi.fn(async () => []),
  MetaMcpError: class extends Error {},
}))

const windowMock = vi.fn()
vi.mock('@/agent/lib/ads/insights', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, fetchCampaignMetricsWindow: (...a: unknown[]) => windowMock(...a) }
})

vi.mock('@/lib/prisma', () => ({
  prisma: { agentKvSetting: { findUnique: vi.fn(async () => null), upsert: vi.fn(), deleteMany: vi.fn(), findMany: vi.fn(async () => []) } },
}))

import { readAdInsights, provenanceOf } from '../insights-source'

/** The owner's real week: $11.49 in a USD account, campaign paused today. */
const REAL_WINDOW = {
  accountId: 'act_1236291335314468',
  currency: 'USD',
  windowDays: 7,
  campaigns: [
    {
      campaignId: '120210000000000001',
      name: 'New Engagement Campaign-01-July 2026',
      spendToday: 0,
      spendWeek: 11.49,
      impressionsToday: 0,
      impressionsWeek: 49824,
      clicksToday: 0,
      clicksWeek: 2389,
      ctrTodayPct: 0,
      ctrWeekPct: 4.79,
      cpcToday: 0,
      roasToday: 0,
      roasWeek: 0,
      dailyBudgetBdt: 2,
      effectiveStatus: 'PAUSED',
      hasEnoughData: true,
      currency: 'USD',
      objective: 'OUTCOME_ENGAGEMENT',
    },
  ],
}

function mcpText(payload: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false }
}

beforeEach(() => {
  enabledMock.mockResolvedValue(true)
  connectionMock.mockResolvedValue({ access_token: 't' })
  callToolMock.mockReset()
  windowMock.mockReset()
  windowMock.mockResolvedValue(REAL_WINDOW)
})

describe('kill-switch / degradation (plan §5 acceptance: old path must keep working)', () => {
  it('MCP disabled → real Graph numbers + honest graph_api provenance', async () => {
    enabledMock.mockResolvedValue(false)
    const r = await readAdInsights(7)
    expect(r.source).toBe('graph_api')
    expect(r.campaigns[0].spendWeek).toBeCloseTo(11.49)
    expect(r.totalSpendLabel).toBe('$11.49')
    expect(r.degradedReason).toContain('kill switch')
    expect(r.mcp).toBeNull()
    expect(callToolMock).not.toHaveBeenCalled()
  })

  it('MCP not connected → graph_api + a Connect instruction', async () => {
    connectionMock.mockResolvedValue(null)
    const r = await readAdInsights(7)
    expect(r.source).toBe('graph_api')
    expect(r.degradedReason).toContain('Connect')
    expect(r.campaigns).toHaveLength(1)
  })

  it('account outside Meta rollout (is_ads_mcp_enabled=false) → graph_api + Meta\'s own reason', async () => {
    callToolMock.mockResolvedValue(
      mcpText({
        ad_accounts: [
          {
            ad_account_id: '1236291335314468',
            is_ads_mcp_enabled: false,
            is_ads_mcp_disabled_reason: 'Ads MCP is gradually being rolled out. Please check back at a later date.',
          },
        ],
      }),
    )
    const r = await readAdInsights(7)
    expect(r.source).toBe('graph_api')
    expect(r.degradedReason).toContain('rollout বাকি')
    expect(r.campaigns[0].impressionsWeek).toBe(49824) // numbers never lost
  })

  it('preferMcp:false forces the legacy path without touching MCP', async () => {
    const r = await readAdInsights(7, { preferMcp: false })
    expect(r.source).toBe('graph_api')
    expect(callToolMock).not.toHaveBeenCalled()
  })
})

describe('MCP-preferred path (when Meta opens the account)', () => {
  beforeEach(() => {
    callToolMock.mockImplementation(async (name: string) => {
      if (name === 'ads_get_ad_accounts') {
        return mcpText({ ad_accounts: [{ ad_account_id: '1236291335314468', is_ads_mcp_enabled: true }] })
      }
      if (name === 'ads_insights_industry_benchmark') return mcpText({ ctr_vs_industry: 'below_average' })
      return mcpText({ ok: name })
    })
  })

  it('enriches with Meta intelligence and labels the source honestly', async () => {
    const r = await readAdInsights(7)
    expect(r.source).toBe('meta_mcp')
    expect(r.sourceLabel).toContain('Ads MCP')
    // The rows still come from Graph — the label must say so, not claim MCP-only.
    expect(r.sourceLabel).toContain('Graph API')
    expect(r.degradedReason).toBeNull()
    expect(r.mcp?.industryBenchmark).toEqual({ ctr_vs_industry: 'below_average' })
    expect(r.campaigns[0].spendWeek).toBeCloseTo(11.49)
  })

  it('MCP answers nothing usable → falls back and says so', async () => {
    callToolMock.mockImplementation(async (name: string) => {
      if (name === 'ads_get_ad_accounts') {
        return mcpText({ ad_accounts: [{ ad_account_id: '1236291335314468', is_ads_mcp_enabled: true }] })
      }
      return { content: [{ type: 'text', text: 'boom' }], isError: true }
    })
    const r = await readAdInsights(7)
    expect(r.source).toBe('graph_api')
    expect(r.degradedReason).toContain('সাড়া দেয়নি')
  })
})

describe('provenanceOf', () => {
  it('permits an MCP claim ONLY on the MCP path', async () => {
    enabledMock.mockResolvedValue(false)
    const graph = provenanceOf(await readAdInsights(7))
    expect(graph.source).toBe('graph_api')
    expect(graph.mcpToolsUsed).toEqual([])
    expect(graph.rule).toContain('NOT from Meta MCP')

    enabledMock.mockResolvedValue(true)
    callToolMock.mockImplementation(async (name: string) =>
      name === 'ads_get_ad_accounts'
        ? mcpText({ ad_accounts: [{ ad_account_id: '1236291335314468', is_ads_mcp_enabled: true }] })
        : mcpText({ ok: 1 }),
    )
    const mcp = provenanceOf(await readAdInsights(7))
    expect(mcp.source).toBe('meta_mcp')
    expect(mcp.mcpToolsUsed).toContain('meta_ads_insights_performance_trend')
  })
})
