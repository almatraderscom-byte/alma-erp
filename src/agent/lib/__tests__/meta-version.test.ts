import { describe, it, expect, afterEach } from 'vitest'
import {
  META_GRAPH_DEFAULT_VERSION,
  classifyMetaError,
  metaGraphBase,
  metaGraphVersion,
} from '@/agent/lib/marketing/meta-version'

const ORIGINAL = process.env.META_GRAPH_VERSION
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.META_GRAPH_VERSION
  else process.env.META_GRAPH_VERSION = ORIGINAL
})

describe('metaGraphVersion — one central, guarded version', () => {
  it('defaults to the contract-tested version', () => {
    delete process.env.META_GRAPH_VERSION
    expect(metaGraphVersion()).toBe(META_GRAPH_DEFAULT_VERSION)
    expect(metaGraphBase()).toBe(`https://graph.facebook.com/${META_GRAPH_DEFAULT_VERSION}`)
  })

  it('valid env override wins (emergency pin without redeploy-wide edits)', () => {
    process.env.META_GRAPH_VERSION = 'v22.0'
    expect(metaGraphVersion()).toBe('v22.0')
  })

  it('garbage override is ignored — no blind bumps via typo', () => {
    process.env.META_GRAPH_VERSION = '22'
    expect(metaGraphVersion()).toBe(META_GRAPH_DEFAULT_VERSION)
    process.env.META_GRAPH_VERSION = 'v220'
    expect(metaGraphVersion()).toBe(META_GRAPH_DEFAULT_VERSION)
  })
})

describe('classifyMetaError — uniform error semantics', () => {
  const body = (code: number, extra: Record<string, unknown> = {}) => ({
    error: { message: 'x', code, fbtrace_id: 'FBTRACE1', ...extra },
  })

  it('190 → auth, not retryable, owner action names the token', () => {
    const c = classifyMetaError(400, body(190))
    expect(c.kind).toBe('auth')
    expect(c.retryable).toBe(false)
    expect(c.fbtraceId).toBe('FBTRACE1')
    expect(c.ownerAction).toContain('token')
  })

  it('permission codes (10, 200–299) → permission, not retryable', () => {
    expect(classifyMetaError(403, body(10)).kind).toBe('permission')
    expect(classifyMetaError(403, body(200)).kind).toBe('permission')
    expect(classifyMetaError(403, body(299)).kind).toBe('permission')
  })

  it('rate-limit codes (4/17/32/613) → retryable rate_limit', () => {
    for (const code of [4, 17, 32, 613]) {
      const c = classifyMetaError(400, body(code))
      expect(c.kind).toBe('rate_limit')
      expect(c.retryable).toBe(true)
    }
  })

  it('100 → validation (our bug — never retried as-is)', () => {
    const c = classifyMetaError(400, body(100, { error_subcode: 1487212 }))
    expect(c.kind).toBe('validation')
    expect(c.retryable).toBe(false)
    expect(c.subcode).toBe(1487212)
  })

  it('server codes / 5xx → retryable server; empty body 500 too', () => {
    expect(classifyMetaError(500, body(1)).kind).toBe('server')
    expect(classifyMetaError(503, null).kind).toBe('server')
    expect(classifyMetaError(503, null).retryable).toBe(true)
  })

  it('unknown codes stay honest — kind unknown with fbtrace for support', () => {
    const c = classifyMetaError(400, body(9999))
    expect(c.kind).toBe('unknown')
    expect(c.ownerAction).toContain('fbtrace')
  })
})
