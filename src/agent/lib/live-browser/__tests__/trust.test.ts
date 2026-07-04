/** P1 §5.4 site trust tiers — per-domain kv, suffix matching, auto-lockdown. */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const kv = vi.hoisted(() => ({ value: null as string | null }))
const mockPrisma = vi.hoisted(() => ({
  agentKvSetting: {
    findUnique: vi.fn(async () => (kv.value === null ? null : { value: kv.value })),
    upsert: vi.fn(async (args: { create: { value: string } }) => {
      kv.value = args.create.value
      return { key: 'live_browser_site_tiers', value: kv.value }
    }),
  },
}))
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

import {
  normalizeDomain,
  tierForHost,
  tierForUrl,
  setSiteTier,
  flagLockdownForUrl,
  lockdownDomains,
  type SiteTierMap,
} from '@/agent/lib/live-browser/trust'

beforeEach(() => {
  kv.value = null
  vi.clearAllMocks()
})

describe('normalizeDomain', () => {
  it('strips scheme, path, port and www', () => {
    expect(normalizeDomain('https://www.Example.com:443/some/path?q=1')).toBe('example.com')
    expect(normalizeDomain('shop.example.com/checkout')).toBe('shop.example.com')
    expect(normalizeDomain('  Example.COM. ')).toBe('example.com')
  })
  it('rejects garbage', () => {
    expect(normalizeDomain('')).toBe('')
    expect(normalizeDomain('not a domain!!')).toBe('')
  })
})

describe('tierForHost (suffix matching)', () => {
  const map: SiteTierMap = {
    'example.com': { tier: 'trusted', reason: 'own site', by: 'owner', at: 'x' },
    'evil.net': { tier: 'lockdown', reason: 'tripwire', by: 'auto', at: 'x' },
  }
  it('matches exact and subdomains', () => {
    expect(tierForHost(map, 'https://example.com/').tier).toBe('trusted')
    expect(tierForHost(map, 'https://shop.example.com/x').tier).toBe('trusted')
    expect(tierForHost(map, 'login.evil.net').tier).toBe('lockdown')
  })
  it('does NOT match lookalike suffixes or unlisted hosts', () => {
    expect(tierForHost(map, 'notexample.com').tier).toBe('general')
    expect(tierForHost(map, 'google.com').tier).toBe('general')
  })
})

describe('setSiteTier / tierForUrl / lockdownDomains', () => {
  it('owner sets a tier, general clears it', async () => {
    const set = await setSiteTier('https://www.mysite.com/page', 'trusted', 'own site')
    expect(set).toEqual({ ok: true, domain: 'mysite.com' })
    expect((await tierForUrl('app.mysite.com')).tier).toBe('trusted')

    await setSiteTier('mysite.com', 'general', 'clear')
    expect((await tierForUrl('mysite.com')).tier).toBe('general')
  })

  it('rejects invalid domains', async () => {
    expect((await setSiteTier('nodots', 'trusted', 'x')).ok).toBe(false)
    expect((await setSiteTier('', 'lockdown', 'x')).ok).toBe(false)
  })

  it('tripwire auto-flag forces lockdown even over owner trusted, and lists it', async () => {
    await setSiteTier('shop.com', 'trusted', 'own site')
    const flagged = await flagLockdownForUrl('https://shop.com/landing', 'injection tripwire')
    expect(flagged).toBe('shop.com')
    const t = await tierForUrl('shop.com')
    expect(t.tier).toBe('lockdown')
    expect(t.entry?.by).toBe('auto')
    expect(await lockdownDomains()).toEqual(['shop.com'])
  })

  it('flagLockdownForUrl never throws on garbage', async () => {
    expect(await flagLockdownForUrl('about:blank', 'x')).toBe(null)
  })
})
