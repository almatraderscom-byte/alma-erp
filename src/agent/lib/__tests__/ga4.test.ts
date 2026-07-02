import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * GA4 Data API integration (Growth Feature 5). Guards the bits that silently
 * break in production:
 *   1. Property-id parsing — owners paste "properties/123", "123", or the wrong
 *      "G-XXXX" measurement id; only a real numeric id may proceed.
 *   2. Graceful degradation — not-connected, no-property, and the 403
 *      scope-missing case (a GSC-only token predating analytics.readonly) must
 *      each return a tagged result, never throw into the turn.
 *   3. Number coercion — GA4 returns metric values as strings.
 */

// Mock the shared Google OAuth token minter.
const tokenMock = vi.fn(async () => 'access-token')
vi.mock('@/agent/lib/gsc', () => ({
  getConnectedGoogleAccessToken: () => tokenMock(),
  isGscConnected: async () => true,
}))

import { resolveGa4PropertyId, runGa4Report } from '../ga4'

beforeEach(() => {
  process.env.GA4_PROPERTY_ID = '123456789'
  tokenMock.mockResolvedValue('access-token')
})
afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.GA4_PROPERTY_ID
})

describe('resolveGa4PropertyId', () => {
  it('accepts a bare numeric id', () => {
    expect(resolveGa4PropertyId('123456789')).toBe('123456789')
  })
  it('extracts the id from "properties/123456789"', () => {
    expect(resolveGa4PropertyId('properties/123456789')).toBe('123456789')
  })
  it('rejects a G-XXXX measurement id', () => {
    expect(resolveGa4PropertyId('G-ABC123')).toBeNull()
  })
  it('falls back to env when no explicit id', () => {
    expect(resolveGa4PropertyId()).toBe('123456789')
  })
})

describe('runGa4Report', () => {
  const base = { startDate: '28daysAgo', endDate: 'yesterday', dimensions: ['sessionSourceMedium'], metrics: ['sessions', 'totalRevenue'] }

  it('no_property when GA4_PROPERTY_ID is unset', async () => {
    delete process.env.GA4_PROPERTY_ID
    const r = await runGa4Report(base)
    expect(r).toMatchObject({ ok: false, kind: 'no_property' })
  })

  it('not_connected when the token mint fails', async () => {
    tokenMock.mockRejectedValueOnce(new Error('not_connected'))
    const r = await runGa4Report(base)
    expect(r).toMatchObject({ ok: false, kind: 'not_connected' })
  })

  it('scope_missing on a 403 insufficient-scope response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ACCESS_TOKEN_SCOPE_INSUFFICIENT', { status: 403 })) as unknown as typeof fetch)
    const r = await runGa4Report(base)
    expect(r).toMatchObject({ ok: false, kind: 'scope_missing' })
  })

  it('parses rows and coerces string metrics to numbers', async () => {
    const payload = {
      dimensionHeaders: [{ name: 'sessionSourceMedium' }],
      metricHeaders: [{ name: 'sessions' }, { name: 'totalRevenue' }],
      rows: [
        { dimensionValues: [{ value: 'google / organic' }], metricValues: [{ value: '512' }, { value: '1999.5' }] },
        { dimensionValues: [{ value: '(direct) / (none)' }], metricValues: [{ value: '88' }, { value: '0' }] },
      ],
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch)
    const r = await runGa4Report(base)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.rows).toHaveLength(2)
      expect(r.rows[0]).toEqual({ dimensions: ['google / organic'], metrics: [512, 1999.5] })
      expect(r.metricHeaders).toEqual(['sessions', 'totalRevenue'])
    }
  })

  it('returns a tagged error on a generic non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch)
    const r = await runGa4Report(base)
    expect(r).toMatchObject({ ok: false, kind: 'error' })
  })
})
