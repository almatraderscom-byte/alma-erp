/**
 * Internal chat calls require ANY head-capable provider key, not Anthropic
 * specifically (owner ruling 2026-08-25 — the self-hosted engine's head runs
 * on Luna/OpenRouter/Gemini; the old Anthropic-only demand 503'd every
 * internal turn on a box that legitimately has no Anthropic key).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { requireAnyHeadProviderKey } from '@/agent/lib/guards'

const KEYS = ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'XAI_API_KEY'] as const
const saved: Record<string, string | undefined> = {}
for (const k of KEYS) saved[k] = process.env[k]

function clearAll() {
  for (const k of KEYS) delete process.env[k]
}

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('requireAnyHeadProviderKey', () => {
  it('passes with ONLY OpenAI (the Luna head) configured', () => {
    clearAll()
    process.env.OPENAI_API_KEY = 'sk-real-looking-key-1234567890'
    expect(requireAnyHeadProviderKey()).toBeNull()
  })

  it('passes with ONLY OpenRouter configured', () => {
    clearAll()
    process.env.OPENROUTER_API_KEY = 'sk-or-real-looking-key-1234567890'
    expect(requireAnyHeadProviderKey()).toBeNull()
  })

  it('passes with ONLY Gemini configured', () => {
    clearAll()
    process.env.GEMINI_API_KEY = 'AIza-real-looking-key-1234567890'
    expect(requireAnyHeadProviderKey()).toBeNull()
  })

  it('503s when NO provider key exists at all', async () => {
    clearAll()
    const res = requireAnyHeadProviderKey()
    expect(res?.status).toBe(503)
    const body = await res!.json()
    expect(body.error).toBe('no_head_provider_key')
  })

  it('placeholder values do not count', () => {
    clearAll()
    process.env.OPENAI_API_KEY = 'REPLACE_ME_PLEASE_WITH_REAL'
    process.env.GEMINI_API_KEY = 'short'
    expect(requireAnyHeadProviderKey()?.status).toBe(503)
  })
})
