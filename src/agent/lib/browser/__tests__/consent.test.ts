import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Consent exists so a dozen-page SEO job does not become a dozen approval cards —
 * a card the owner taps without reading is worse than no card. So the value of
 * this feature depends entirely on the box around it holding: these tests pin the
 * refusals, not the happy path.
 */
const h = vi.hoisted(() => ({ kv: new Map<string, string>() }))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentKvSetting: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        const value = h.kv.get(where.key)
        return value === undefined ? null : { value }
      },
      upsert: async ({ where, create, update }: { where: { key: string }; create: { value: string }; update: { value: string } }) => {
        h.kv.set(where.key, h.kv.has(where.key) ? update.value : create.value)
        return { key: where.key }
      },
    },
  },
}))

import {
  BROWSER_CONSENT_KV_KEY,
  BROWSER_CONSENT_MAX_TASKS_KEY,
  BROWSER_CONSENT_TTL_KEY,
  consumeBrowserConsent,
  getBrowserConsent,
  grantBrowserConsent,
  revokeBrowserConsent,
} from '@/agent/lib/browser/consent'
import type { BrowserTaskPayload } from '@/agent/lib/browser/actions'

const CHAT = 'conv-1'

function payload(over: Partial<BrowserTaskPayload> = {}): BrowserTaskPayload {
  return {
    goal: 'read a page',
    steps: [{ action: 'goto', url: 'https://example.com' }],
    conversationId: CHAT,
    driver: 'vps',
    ...over,
  }
}

beforeEach(() => {
  h.kv.clear()
})

describe('grant', () => {
  it('records a grant with an expiry and a task budget', async () => {
    const res = await grantBrowserConsent(CHAT, 'vps')
    expect(res.ok).toBe(true)
    expect(res.entry?.remaining).toBeGreaterThan(0)
    expect(Date.parse(res.entry!.expiresAt)).toBeGreaterThan(Date.now())
  })

  it('refuses to grant for the owner\'s own Chrome', async () => {
    const res = await grantBrowserConsent(CHAT, 'companion')
    expect(res.ok).toBe(false)
    expect(await getBrowserConsent(CHAT)).toBeNull()
  })

  it('refuses without a conversation', async () => {
    expect((await grantBrowserConsent('', 'vps')).ok).toBe(false)
  })

  it('clamps an absurd KV budget instead of trusting it', async () => {
    h.kv.set(BROWSER_CONSENT_MAX_TASKS_KEY, '999999')
    h.kv.set(BROWSER_CONSENT_TTL_KEY, '999999')
    const res = await grantBrowserConsent(CHAT, 'vps')
    expect(res.entry!.remaining).toBeLessThanOrEqual(100)
    expect(Date.parse(res.entry!.expiresAt) - Date.now()).toBeLessThanOrEqual(6 * 60 * 60_000 + 1000)
  })
})

describe('consume — what a grant does cover', () => {
  it('lets an ordinary VPS task through and spends one unit', async () => {
    const granted = await grantBrowserConsent(CHAT, 'vps')
    const before = granted.entry!.remaining
    const check = await consumeBrowserConsent(payload(), false)
    expect(check.granted).toBe(true)
    expect(check.remaining).toBe(before - 1)
  })

  it('spends down and then starts asking again', async () => {
    h.kv.set(BROWSER_CONSENT_MAX_TASKS_KEY, '2')
    await grantBrowserConsent(CHAT, 'vps')
    expect((await consumeBrowserConsent(payload(), false)).granted).toBe(true)
    expect((await consumeBrowserConsent(payload(), false)).granted).toBe(true)
    const third = await consumeBrowserConsent(payload(), false)
    expect(third.granted).toBe(false)
    expect(third.reason).toContain('আবার জিজ্ঞেস')
  })
})

describe('consume — what a grant never covers', () => {
  it('a critical (money / irreversible) task always asks', async () => {
    await grantBrowserConsent(CHAT, 'vps')
    const check = await consumeBrowserConsent(payload(), true)
    expect(check.granted).toBe(false)
  })

  it('a task touching an owner-only host always asks', async () => {
    await grantBrowserConsent(CHAT, 'vps')
    const check = await consumeBrowserConsent(
      payload({ driver: 'companion', ownerOnlyHosts: [{ host: 'facebook.com', why: 'Meta business login' }] }),
      false,
    )
    expect(check.granted).toBe(false)
  })

  it('the owner\'s own Chrome always asks', async () => {
    await grantBrowserConsent(CHAT, 'vps')
    expect((await consumeBrowserConsent(payload({ driver: 'companion' }), false)).granted).toBe(false)
  })

  it('a vps grant does not silently cover a live-view session', async () => {
    await grantBrowserConsent(CHAT, 'vps')
    expect((await consumeBrowserConsent(payload({ driver: 'vps_live' }), false)).granted).toBe(false)
  })

  it('does not leak into another conversation', async () => {
    await grantBrowserConsent(CHAT, 'vps')
    const other = await consumeBrowserConsent(payload({ conversationId: 'conv-2' }), false)
    expect(other.granted).toBe(false)
  })

  it('a task with no conversation always asks', async () => {
    await grantBrowserConsent(CHAT, 'vps')
    expect((await consumeBrowserConsent(payload({ conversationId: null }), false)).granted).toBe(false)
  })

  it('an expired grant asks again and is cleaned up', async () => {
    h.kv.set(
      BROWSER_CONSENT_KV_KEY,
      JSON.stringify({
        [CHAT]: {
          driver: 'vps',
          grantedAt: new Date(Date.now() - 7200_000).toISOString(),
          expiresAt: new Date(Date.now() - 3600_000).toISOString(),
          remaining: 5,
        },
      }),
    )
    const check = await consumeBrowserConsent(payload(), false)
    expect(check.granted).toBe(false)
    expect(await getBrowserConsent(CHAT)).toBeNull()
  })

  it('a corrupt stored value is treated as no grant, not as a crash', async () => {
    h.kv.set(BROWSER_CONSENT_KV_KEY, 'not json')
    expect((await consumeBrowserConsent(payload(), false)).granted).toBe(false)
  })
})

describe('revoke', () => {
  it('stops further tasks from riding the grant', async () => {
    await grantBrowserConsent(CHAT, 'vps')
    await revokeBrowserConsent(CHAT)
    expect(await getBrowserConsent(CHAT)).toBeNull()
    expect((await consumeBrowserConsent(payload(), false)).granted).toBe(false)
  })
})
