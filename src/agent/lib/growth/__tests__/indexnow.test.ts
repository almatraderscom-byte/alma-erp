import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { toStorefrontUrl, getIndexNowKey, submitToIndexNow } from '../indexnow'

/**
 * IndexNow is the "tell every non-Google engine instantly" layer of Growth
 * Feature 4. These guard the two things that quietly break in production:
 *   1. URL normalisation — the head passes bare slugs / paths / full URLs
 *      interchangeably, and anything off almatraders.com must be dropped (we
 *      must never ping a competitor/attacker-supplied host).
 *   2. Graceful degradation — no key, no valid URLs, or a non-2xx endpoint must
 *      return a tagged error, never throw into the turn.
 */

const ORIGIN = 'https://www.almatraders.com'

describe('toStorefrontUrl', () => {
  it('turns a bare product slug into a storefront product URL', () => {
    expect(toStorefrontUrl('product-code-360-men')).toBe(`${ORIGIN}/products/product-code-360-men`)
  })
  it('prefixes an absolute path with the storefront origin', () => {
    expect(toStorefrontUrl('/products/x')).toBe(`${ORIGIN}/products/x`)
  })
  it('keeps a full on-host URL', () => {
    expect(toStorefrontUrl(`${ORIGIN}/products/x`)).toBe(`${ORIGIN}/products/x`)
  })
  it('rejects an off-host URL', () => {
    expect(toStorefrontUrl('https://evil.example.com/x')).toBeNull()
    expect(toStorefrontUrl('   ')).toBeNull()
  })
})

describe('getIndexNowKey', () => {
  const prev = process.env.INDEXNOW_KEY
  afterEach(() => {
    process.env.INDEXNOW_KEY = prev
  })
  it('accepts a valid 8-128 hex key', () => {
    process.env.INDEXNOW_KEY = 'b88a4c11070b907dac29af6a42cbfbcf'
    expect(getIndexNowKey()).toBe('b88a4c11070b907dac29af6a42cbfbcf')
  })
  it('rejects a non-hex / too-short key', () => {
    process.env.INDEXNOW_KEY = 'nope'
    expect(getIndexNowKey()).toBeNull()
    delete process.env.INDEXNOW_KEY
    expect(getIndexNowKey()).toBeNull()
  })
})

describe('submitToIndexNow', () => {
  const prev = process.env.INDEXNOW_KEY
  beforeEach(() => {
    process.env.INDEXNOW_KEY = 'b88a4c11070b907dac29af6a42cbfbcf'
  })
  afterEach(() => {
    process.env.INDEXNOW_KEY = prev
    vi.restoreAllMocks()
  })

  it('fails cleanly when no key is configured', async () => {
    delete process.env.INDEXNOW_KEY
    const r = await submitToIndexNow(['product-code-360-men'])
    expect(r.ok).toBe(false)
  })

  it('fails cleanly when no valid on-host URL survives normalisation', async () => {
    const r = await submitToIndexNow(['https://evil.example.com/x'])
    expect(r.ok).toBe(false)
  })

  it('reports 202 as success with key validation pending when the key file is absent', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response('', { status: 202, statusText: 'Accepted' })
      // GET key-file check → not found
      return new Response('', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    const r = await submitToIndexNow(['product-code-360-men', 'product-code-360-men'])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.status).toBe(202)
      expect(r.submitted).toEqual([`${ORIGIN}/products/product-code-360-men`]) // deduped
      expect(r.keyValidationPending).toBe(true)
    }
  })

  it('marks key validation done when the hosted key file matches', async () => {
    const key = 'b88a4c11070b907dac29af6a42cbfbcf'
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response('', { status: 200, statusText: 'OK' })
      return new Response(key, { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    const r = await submitToIndexNow(['/products/x'])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.keyValidationPending).toBe(false)
  })

  it('returns a tagged error on a non-2xx endpoint response', async () => {
    const fetchMock = vi.fn(async () => new Response('bad key', { status: 403, statusText: 'Forbidden' }))
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    const r = await submitToIndexNow(['product-code-360-men'])
    expect(r.ok).toBe(false)
  })
})
