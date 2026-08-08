import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The ALMA Companion extension authenticates with its OWN tokens — a single-use
 * pairing code, then a device bearer token stored only as a hash. It has no
 * session cookie.
 *
 * For a long time it worked anyway, because Chrome treated an extension's fetches
 * as first-party and quietly attached the owner's NextAuth cookie (SameSite=Lax).
 * The middleware was therefore never exercised on the path that mattered, and the
 * cookie was silently doing the gatekeeping. When Chrome stopped sending it, the
 * failure was maximally confusing: poll got a 401 that had nothing to do with the
 * token, the extension erased its own token in response, and every fresh pairing
 * code the agent generated then failed identically. The owner saw only
 * "Unauthorized" and reasonably assumed the codes were bad.
 *
 * So these three paths must stay public in middleware, and their handlers must
 * keep doing the real check. This test pins both halves — a silent removal here
 * would not surface until the owner next tries to pair, possibly months later.
 */

const ROOT = process.cwd()
const MIDDLEWARE = readFileSync(join(ROOT, 'src/proxy.ts'), 'utf8')

const EXTENSION_PATHS = [
  '/api/assistant/live-browser/pair',
  '/api/assistant/live-browser/poll',
  '/api/assistant/live-browser/result',
] as const

describe('companion extension paths stay reachable without a session cookie', () => {
  it.each(EXTENSION_PATHS)('%s is allowlisted in middleware', (path) => {
    expect(MIDDLEWARE).toContain(`pathname === '${path}'`)
  })

  it('the owner-facing watch page is NOT allowlisted — it is a browser page, cookie-gated', () => {
    expect(MIDDLEWARE).not.toContain("'/api/assistant/live-browser/watch'")
  })
})

describe('each allowlisted path still authenticates itself', () => {
  it('pair only accepts a real one-time code, and burns it', () => {
    const route = readFileSync(join(ROOT, 'src/app/api/assistant/live-browser/pair/route.ts'), 'utf8')
    expect(route).toContain('redeemPairingCode')
    expect(route).toContain('isLiveBrowserEnabled')
    expect(route).toContain('requireAgentEnabled')

    // The burn + expiry live in the shared module, not the route.
    const companion = readFileSync(join(ROOT, 'src/agent/lib/live-browser/companion.ts'), 'utf8')
    expect(companion).toContain('pairingCode: null') // single use
    expect(companion).toContain('code_expired')
  })

  it.each(['poll', 'result'])('%s verifies the device bearer token', (name) => {
    const route = readFileSync(join(ROOT, `src/app/api/assistant/live-browser/${name}/route.ts`), 'utf8')
    expect(route).toContain('authenticateDevice')
    expect(route).toContain('requireAgentEnabled')
  })

  it('device tokens are stored hashed, never raw', () => {
    const companion = readFileSync(join(ROOT, 'src/agent/lib/live-browser/companion.ts'), 'utf8')
    expect(companion).toContain('tokenHash: hashToken(')
    expect(companion).toContain('timingSafeEqual')
  })
})

describe('the extension does not depend on a browser cookie', () => {
  const BACKGROUND = readFileSync(join(ROOT, 'extension/alma-companion/background.js'), 'utf8')

  it("every call to our API says credentials: 'omit'", () => {
    // Three call sites: pair, poll, result. If a fourth is added it must say so too,
    // otherwise the old invisible-cookie dependency creeps back in.
    const omits = BACKGROUND.match(/credentials: 'omit'/g) ?? []
    expect(omits.length).toBeGreaterThanOrEqual(3)
  })

  it('never asks for cookies to be included', () => {
    expect(BACKGROUND).not.toContain("credentials: 'include'")
  })
})
