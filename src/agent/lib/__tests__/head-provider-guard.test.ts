/**
 * Internal chat calls require the provider key of the model the DEFAULT head
 * will actually run on (owner ruling 2026-08-25 + Codex P1 #854): the old
 * Anthropic-only demand 503'd the self-hosted engine whose head never uses
 * it, and a naive any-key check would admit a box whose only key belongs to
 * a provider the head never touches.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const routing = vi.hoisted(() => ({
  getDefaultHeadModelId: vi.fn<() => Promise<string>>(),
}))
vi.mock('@/agent/lib/models/routing-config', () => routing)

import { requireDefaultHeadProviderKey } from '@/agent/lib/guards'
import { getModel } from '@/agent/lib/models/registry'

const KEYS = ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'XAI_API_KEY'] as const
const saved: Record<string, string | undefined> = {}
for (const k of KEYS) saved[k] = process.env[k]

function clearAll() {
  for (const k of KEYS) delete process.env[k]
}

/** A registry model id per provider, so the test tracks the real registry. */
function modelIdForProvider(provider: string): string | null {
  for (const id of ['gpt-5.6-luna', 'gemini-3.1-pro', 'claude-sonnet-4-6', 'grok-4.20']) {
    try {
      if (getModel(id).provider === provider) return id
    } catch { /* not in registry */ }
  }
  return null
}

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  vi.clearAllMocks()
})

describe('requireDefaultHeadProviderKey', () => {
  it('passes when the default head provider key is present (OpenAI head + OpenAI key)', async () => {
    const id = modelIdForProvider('openai')
    if (!id) return
    routing.getDefaultHeadModelId.mockResolvedValue(id)
    clearAll()
    process.env.OPENAI_API_KEY = 'sk-real-looking-key-1234567890'
    expect(await requireDefaultHeadProviderKey()).toBeNull()
  })

  it('503s when only an UNRELATED provider key exists (OpenAI head, Gemini-only box)', async () => {
    const id = modelIdForProvider('openai')
    if (!id) return
    routing.getDefaultHeadModelId.mockResolvedValue(id)
    clearAll()
    process.env.GEMINI_API_KEY = 'AIza-real-looking-key-1234567890'
    const res = await requireDefaultHeadProviderKey()
    expect(res?.status).toBe(503)
  })

  it('a Gemini default head needs only the Gemini key', async () => {
    const id = modelIdForProvider('google')
    if (!id) return
    routing.getDefaultHeadModelId.mockResolvedValue(id)
    clearAll()
    process.env.GEMINI_API_KEY = 'AIza-real-looking-key-1234567890'
    expect(await requireDefaultHeadProviderKey()).toBeNull()
  })

  it('falls back to any-key when the default-head lookup itself fails', async () => {
    routing.getDefaultHeadModelId.mockRejectedValue(new Error('kv down'))
    clearAll()
    process.env.OPENROUTER_API_KEY = 'sk-or-real-looking-key-1234567890'
    expect(await requireDefaultHeadProviderKey()).toBeNull()
  })

  it('503s no_head_provider_key when lookup fails AND no key exists', async () => {
    routing.getDefaultHeadModelId.mockRejectedValue(new Error('kv down'))
    clearAll()
    const res = await requireDefaultHeadProviderKey()
    expect(res?.status).toBe(503)
    const body = await res!.json()
    expect(body.error).toBe('no_head_provider_key')
  })
})
