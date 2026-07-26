import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * The driver router is a SAFETY rule, not a preference.
 *
 * Its whole reason to exist is that a datacenter browser must never carry the
 * owner's business identity — a Meta/bank/infra login from a VPS IP risks a
 * security checkpoint or an account lock on a live business asset. So these tests
 * pin the part that must never regress: an owner-only host lands on the
 * `companion` driver no matter what the caller asked for, and the attempted
 * override stays visible for the audit trail.
 */

// Hoisted so the (hoisted) vi.mock factory can reference the same store.
const h = vi.hoisted(() => {
  const kv = new Map<string, string>()
  return { kv }
})

vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentKvSetting: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        const value = h.kv.get(where.key)
        return value === undefined ? null : { value }
      },
    },
  },
}))

import {
  DEFAULT_BROWSER_DRIVER,
  driverLabel,
  hostsInBrowserTask,
  isBrowserDriver,
  isVpsDriver,
  resolveBrowserDriver,
  OWNER_ONLY_DOMAINS_KEY,
} from '@/agent/lib/browser/drivers'
import type { BrowserStep } from '@/agent/lib/browser/actions'

function task(...urls: string[]) {
  const steps: BrowserStep[] = urls.map((url) => ({ action: 'goto' as const, url }))
  return { steps }
}

beforeEach(() => {
  h.kv.clear()
})

describe('hostsInBrowserTask', () => {
  it('collects startUrl and every goto host, de-duplicated', () => {
    const hosts = hostsInBrowserTask({
      startUrl: 'https://example.com/a',
      steps: [
        { action: 'goto', url: 'https://example.com/b' },
        { action: 'goto', url: 'https://other.test/c' },
        { action: 'click', selector: '#x' },
      ],
    })
    expect(hosts.sort()).toEqual(['example.com', 'other.test'])
  })

  it('ignores non-goto steps and unparseable urls', () => {
    expect(hostsInBrowserTask({ steps: [{ action: 'screenshot' }] })).toEqual([])
    expect(hostsInBrowserTask({ steps: [{ action: 'goto', url: 'not a url' }] })).toEqual([])
  })
})

describe('resolveBrowserDriver — default routing', () => {
  it('sends an ordinary public site to the default VPS driver', async () => {
    const d = await resolveBrowserDriver(task('https://en.wikipedia.org/wiki/SEO'))
    expect(d.driver).toBe(DEFAULT_BROWSER_DRIVER)
    expect(d.driver).toBe('vps')
    expect(d.ownerOnlyHosts).toEqual([])
    expect(d.overrodeRequest).toBe(false)
  })

  it('honours an explicit vps_live request on an open site', async () => {
    const d = await resolveBrowserDriver(task('https://example.com'), 'vps_live')
    expect(d.driver).toBe('vps_live')
    expect(d.overrodeRequest).toBe(false)
  })

  it('ignores an unknown driver string and falls back to the default', async () => {
    const d = await resolveBrowserDriver(task('https://example.com'), 'browserbase')
    expect(d.driver).toBe('vps')
    expect(d.requestedDriver).toBeUndefined()
  })
})

describe('resolveBrowserDriver — owner-only hosts are not negotiable', () => {
  it.each([
    'https://business.facebook.com/adsmanager',
    'https://www.facebook.com/almalifestyle',
    'https://instagram.com/explore',
    'https://ads.google.com/aw/campaigns',
    'https://www.bkash.com/login',
    'https://www.dutchbanglabank.com/ibanking',
    'https://vercel.com/dashboard',
    'https://github.com/settings',
  ])('forces companion for %s', async (url) => {
    const d = await resolveBrowserDriver(task(url))
    expect(d.driver).toBe('companion')
    expect(d.ownerOnlyHosts.length).toBeGreaterThan(0)
  })

  it('overrides an explicit vps request and records that it did', async () => {
    const d = await resolveBrowserDriver(task('https://business.facebook.com/x'), 'vps')
    expect(d.driver).toBe('companion')
    expect(d.overrodeRequest).toBe(true)
    expect(d.requestedDriver).toBe('vps')
    expect(d.reason).toContain('business.facebook.com')
  })

  it('overrides vps_live too — watching it does not make a datacenter login safe', async () => {
    const d = await resolveBrowserDriver(task('https://bkash.com/'), 'vps_live')
    expect(d.driver).toBe('companion')
    expect(d.overrodeRequest).toBe(true)
  })

  it('does not flag a companion request as an override', async () => {
    const d = await resolveBrowserDriver(task('https://facebook.com/'), 'companion')
    expect(d.driver).toBe('companion')
    expect(d.overrodeRequest).toBe(false)
  })

  it('a single owner-only host in a mixed task pulls the WHOLE task to companion', async () => {
    const d = await resolveBrowserDriver(task('https://example.com', 'https://facebook.com/ads'))
    expect(d.driver).toBe('companion')
    expect(d.ownerOnlyHosts.map((x) => x.host)).toEqual(['facebook.com'])
  })
})

describe('resolveBrowserDriver — domain matching is exact, never substring', () => {
  it('does not match a lookalike host that merely contains the domain', async () => {
    const d = await resolveBrowserDriver(task('https://notfacebook.com/page'))
    expect(d.driver).toBe('vps')
  })

  it('does not match a domain used as a path or query value', async () => {
    const d = await resolveBrowserDriver(task('https://example.com/?next=facebook.com'))
    expect(d.driver).toBe('vps')
  })

  it('matches subdomains of an owner-only domain', async () => {
    const d = await resolveBrowserDriver(task('https://deep.sub.facebook.com/x'))
    expect(d.driver).toBe('companion')
  })

  it('is case-insensitive and tolerates a trailing dot', async () => {
    const d = await resolveBrowserDriver(task('https://WWW.FaceBook.CoM./x'))
    expect(d.driver).toBe('companion')
  })
})

describe('resolveBrowserDriver — owner-tunable extra domains', () => {
  it('adds KV domains to the built-in list', async () => {
    h.kv.set(OWNER_ONLY_DOMAINS_KEY, 'myportal.example, supplier.test')
    const d = await resolveBrowserDriver(task('https://myportal.example/login'))
    expect(d.driver).toBe('companion')
    expect(d.ownerOnlyHosts[0].why).toBe('owner-listed domain')
  })

  it('KV can only ADD — it never removes a built-in owner-only domain', async () => {
    h.kv.set(OWNER_ONLY_DOMAINS_KEY, '')
    const d = await resolveBrowserDriver(task('https://facebook.com/'), 'vps')
    expect(d.driver).toBe('companion')
  })
})

describe('driver helpers', () => {
  it('classifies which drivers run on the VPS', () => {
    expect(isVpsDriver('vps')).toBe(true)
    expect(isVpsDriver('vps_live')).toBe(true)
    expect(isVpsDriver('companion')).toBe(false)
  })

  it('validates driver strings', () => {
    expect(isBrowserDriver('vps_live')).toBe(true)
    expect(isBrowserDriver('cloud')).toBe(false)
    expect(isBrowserDriver(undefined)).toBe(false)
  })

  it('labels every driver in Bangla for the approval card', () => {
    expect(driverLabel('companion')).toContain('Chrome')
    expect(driverLabel('vps_live')).toContain('লাইভ')
    expect(driverLabel('vps')).toContain('VPS')
  })
})
