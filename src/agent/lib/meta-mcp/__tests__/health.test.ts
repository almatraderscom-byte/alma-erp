import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Meta Ads MCP observability (Phase MA4). getMetaMcpHealth aggregates the
 * telemetry every bridged tool already writes — counting ONLY meta_ads_* /
 * meta_ads:* rows — into 24h/7d windows + last-success + last-error. The
 * auth-expiry alert is throttled to at most once per 6h.
 */

const findManyMock = vi.fn()
const kvFindUniqueMock = vi.fn(async (): Promise<{ value: string } | null> => null)
const kvUpsertMock = vi.fn(async () => ({}))
// notifyOwner takes a payload, so the mock must accept args — otherwise the spread
// call below is TS2556 and reading mock.calls[0][0] is TS2493 (empty-tuple index).
const notifyOwnerMock = vi.fn(async (..._args: unknown[]) => {})
vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentToolEvent: { findMany: (...a: unknown[]) => findManyMock(...(a as [])) },
    agentKvSetting: {
      findUnique: (...a: unknown[]) => kvFindUniqueMock(...(a as [])),
      upsert: (...a: unknown[]) => kvUpsertMock(...(a as [])),
    },
  },
}))
vi.mock('@/agent/lib/notify-owner', () => ({ notifyOwner: (...a: unknown[]) => notifyOwnerMock(...a) }))

import { getMetaMcpHealth, maybeAlertMetaMcpAuthExpiry } from '../health'

const now = Date.now()
const ago = (ms: number) => new Date(now - ms)

beforeEach(() => {
  findManyMock.mockReset()
  kvFindUniqueMock.mockResolvedValue(null)
  kvUpsertMock.mockClear()
  notifyOwnerMock.mockClear()
})

describe('getMetaMcpHealth', () => {
  it('counts only meta tools, splits 24h/7d, computes success rate + last success/error', async () => {
    findManyMock.mockResolvedValue([
      { toolName: 'meta_ads_insights_performance_trend', success: true, errorCode: null, ts: ago(3600_000) },
      { toolName: 'meta_ads_get_ad_accounts', success: false, errorCode: 'rate_limited', ts: ago(2 * 3600_000) },
      { toolName: 'meta_ads:ads_create_campaign', success: true, errorCode: null, ts: ago(3 * 86400_000) }, // 3d ago (7d only)
      { toolName: 'get_orders', success: true, errorCode: null, ts: ago(1000) }, // NOT a meta tool — ignored
    ])
    const h = await getMetaMcpHealth()
    expect(h.last24h.calls).toBe(2) // the two within 24h
    expect(h.last24h.ok).toBe(1)
    expect(h.last24h.failed).toBe(1)
    expect(h.last24h.successRate).toBe(50)
    expect(h.last24h.errors).toEqual({ rate_limited: 1 })
    expect(h.last7d.calls).toBe(3) // includes the 3-day-old write
    expect(h.lastSuccessAt).not.toBeNull()
    expect(h.lastError).toEqual({ code: 'rate_limited', toolName: 'meta_ads_get_ad_accounts' })
  })

  it('empty snapshot when telemetry throws (fail-open)', async () => {
    findManyMock.mockRejectedValue(new Error('db down'))
    const h = await getMetaMcpHealth()
    expect(h.last7d.calls).toBe(0)
    expect(h.lastSuccessAt).toBeNull()
  })
})

describe('maybeAlertMetaMcpAuthExpiry (throttle)', () => {
  it('sends an owner ntfy when no recent alert', async () => {
    await maybeAlertMetaMcpAuthExpiry()
    expect(notifyOwnerMock).toHaveBeenCalledTimes(1)
    expect((notifyOwnerMock.mock.calls[0][0] as { message: string }).message).toContain('Connect')
    expect(kvUpsertMock).toHaveBeenCalled()
  })

  it('does NOT re-send within the 6h throttle window', async () => {
    kvFindUniqueMock.mockResolvedValue({ value: new Date(now - 60_000).toISOString() })
    await maybeAlertMetaMcpAuthExpiry()
    expect(notifyOwnerMock).not.toHaveBeenCalled()
  })
})
