/**
 * Audit P0-5 — production must never fall back to the development signing key.
 * Missing AGENT_INTERNAL_TOKEN in production ⇒ signing/verification THROW
 * (fail closed; the universal tool guard converts that into a blocked write,
 * reads proceed via its unsigned fallback). Dev/test keep the fixed key so
 * envelopes stay deterministic.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { buildActionEnvelope, signEnvelope, verifyEnvelope } from '../policy/capability-token'

const OLD_TOKEN = process.env.AGENT_INTERNAL_TOKEN
const OLD_VERCEL = process.env.VERCEL_ENV

afterEach(() => {
  if (OLD_TOKEN === undefined) delete process.env.AGENT_INTERNAL_TOKEN
  else process.env.AGENT_INTERNAL_TOKEN = OLD_TOKEN
  if (OLD_VERCEL === undefined) delete process.env.VERCEL_ENV
  else process.env.VERCEL_ENV = OLD_VERCEL
})

function envelope() {
  return buildActionEnvelope({
    actor: 'owner',
    surface: 'owner',
    instructionOrigin: 'owner_direct',
    tool: 'send_whatsapp',
    input: { to: '+880', body: 'hi' },
    riskTier: 'R3',
  })
}

describe('envelope signing key (P0-5 fail-closed)', () => {
  it('production + missing token ⇒ signing throws (no dev-key fallback)', () => {
    delete process.env.AGENT_INTERNAL_TOKEN
    process.env.VERCEL_ENV = 'production'
    expect(() => signEnvelope(envelope())).toThrow(/AGENT_INTERNAL_TOKEN missing/)
  })

  it('production + missing token ⇒ verification also throws (forgery impossible)', () => {
    process.env.AGENT_INTERNAL_TOKEN = 'real-secret'
    delete process.env.VERCEL_ENV
    const signed = signEnvelope(envelope())
    delete process.env.AGENT_INTERNAL_TOKEN
    process.env.VERCEL_ENV = 'production'
    expect(() => verifyEnvelope(signed, { to: '+880', body: 'hi' })).toThrow(/AGENT_INTERNAL_TOKEN missing/)
  })

  it('a dev-key-signed envelope NEVER verifies against a real production key', () => {
    delete process.env.AGENT_INTERNAL_TOKEN
    delete process.env.VERCEL_ENV
    const forged = signEnvelope(envelope()) // signed with the public dev key
    process.env.AGENT_INTERNAL_TOKEN = 'real-secret'
    process.env.VERCEL_ENV = 'production'
    const v = verifyEnvelope(forged, { to: '+880', body: 'hi' })
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('bad_signature')
  })

  it('non-production keeps the deterministic dev key', () => {
    delete process.env.AGENT_INTERNAL_TOKEN
    delete process.env.VERCEL_ENV
    const signed = signEnvelope(envelope())
    expect(verifyEnvelope(signed, { to: '+880', body: 'hi' }).ok).toBe(true)
  })
})
