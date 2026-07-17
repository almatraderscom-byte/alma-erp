import { describe, it, expect, vi, afterEach } from 'vitest'
import { toOpenAiGenerationParams } from '../generation-params'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function loadResolve() {
  return (await import('../generation-params')).resolveGenerationParams
}

describe('toOpenAiGenerationParams (pure mapping)', () => {
  it('maps neutral → OpenAI field names, omitting undefined', () => {
    expect(toOpenAiGenerationParams({ maxTokens: 8192, temperature: 0.7, topP: 0.95 })).toEqual({
      max_tokens: 8192,
      temperature: 0.7,
      top_p: 0.95,
    })
    expect(toOpenAiGenerationParams({ maxTokens: 8192 })).toEqual({ max_tokens: 8192 })
    expect(toOpenAiGenerationParams({})).toEqual({})
  })
})

describe('resolveGenerationParams (P9 — uniform sampling)', () => {
  it('returns {} when the flag is off → every adapter keeps its exact current request', async () => {
    vi.resetModules()
    const resolve = await loadResolve()
    expect(resolve({ thinking: 'none' })).toEqual({})
    expect(resolve({ thinking: 'level' })).toEqual({})
  })

  it('when on: unifies max_tokens always, but omits the sampler for reasoning models', async () => {
    vi.stubEnv('AGENT_UNIFORM_SAMPLING', 'on')
    vi.resetModules()
    const resolve = await loadResolve()
    // reasoning head (Grok/Gemini/DeepSeek with thinking) → max_tokens only
    expect(resolve({ thinking: 'level' })).toEqual({ maxTokens: 8192 })
    expect(resolve({ thinking: 'adaptive' })).toEqual({ maxTokens: 8192 })
    // non-reasoning → full shared sampler
    expect(resolve({ thinking: 'none' })).toEqual({ maxTokens: 8192, temperature: 0.7, topP: 0.95 })
    expect(resolve({ thinking: undefined })).toEqual({ maxTokens: 8192, temperature: 0.7, topP: 0.95 })
  })
})
