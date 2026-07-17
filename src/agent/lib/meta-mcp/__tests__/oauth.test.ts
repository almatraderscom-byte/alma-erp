import { describe, it, expect, vi } from 'vitest'

/**
 * Meta Ads MCP OAuth (Phase MA1) — guards the discovery detail that live-testing
 * caught: Meta's authorization server identifier CARRIES A PATH
 * ("https://mcp.facebook.com/ads"), and RFC 8414 inserts the well-known segment
 * between host and path. The path-appended form 404s on Meta; only the
 * path-aware form answers. Trying the wrong form first is fine — trying ONLY
 * the wrong form silently degrades to the classic-dialog fallback.
 */

vi.mock('@/lib/prisma', () => ({ prisma: { agentKvSetting: { findUnique: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn(), findMany: vi.fn() } } }))

import { authServerMetadataCandidates, getMetaMcpRedirectUri } from '../oauth'

describe('authServerMetadataCandidates', () => {
  it('puts the RFC 8414 path-aware form FIRST for a path-carrying issuer (Meta live shape)', () => {
    const c = authServerMetadataCandidates('https://mcp.facebook.com/ads')
    expect(c[0]).toBe('https://mcp.facebook.com/.well-known/oauth-authorization-server/ads')
    expect(c).toContain('https://mcp.facebook.com/ads/.well-known/oauth-authorization-server')
    expect(c).toContain('https://mcp.facebook.com/.well-known/openid-configuration/ads')
  })

  it('uses the plain root form for a pathless issuer', () => {
    const c = authServerMetadataCandidates('https://www.facebook.com/')
    expect(c[0]).toBe('https://www.facebook.com/.well-known/oauth-authorization-server')
    expect(c).toHaveLength(2)
  })
})

describe('getMetaMcpRedirectUri', () => {
  it('builds the callback path under /api/assistant/meta-mcp (GSC base priority)', () => {
    const prev = { NEXTAUTH_URL: process.env.NEXTAUTH_URL, APP_URL: process.env.APP_URL, VERCEL_URL: process.env.VERCEL_URL }
    delete process.env.NEXTAUTH_URL
    delete process.env.APP_URL
    delete process.env.VERCEL_URL
    try {
      expect(getMetaMcpRedirectUri('https://preview.example.app/')).toBe(
        'https://preview.example.app/api/assistant/meta-mcp/auth/callback',
      )
    } finally {
      if (prev.NEXTAUTH_URL) process.env.NEXTAUTH_URL = prev.NEXTAUTH_URL
      if (prev.APP_URL) process.env.APP_URL = prev.APP_URL
      if (prev.VERCEL_URL) process.env.VERCEL_URL = prev.VERCEL_URL
    }
  })
})
