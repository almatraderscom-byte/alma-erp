import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TurnEvent } from '@/agent/lib/models/types'

/**
 * The owner's thinking level has to LAND on the provider — a picker that only
 * changes a database row is exactly the class of control this repo has been
 * burned by before (a mode chip nothing read, a pin write that matched no row).
 * So these tests assert the WIRE: what each adapter actually sends when a level
 * is picked, and that Auto leaves the request as it was.
 */

// ── Anthropic SDK mock ───────────────────────────────────────────────────────
const anthropicCapture: { params?: Record<string, unknown> } = {}
vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    messages = {
      create: async (params: Record<string, unknown>) => {
        anthropicCapture.params = params
        return (async function* () {
          yield { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } }
          yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
          yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }
          yield { type: 'message_delta', usage: { output_tokens: 2 } }
        })()
      },
    }
  }
  return { default: Anthropic }
})

// ── Google SDK mock ──────────────────────────────────────────────────────────
const googleCapture: { generationConfig?: Record<string, unknown> } = {}
vi.mock('@google/generative-ai', () => {
  class GoogleGenerativeAI {
    getGenerativeModel(params: { generationConfig?: Record<string, unknown> }) {
      googleCapture.generationConfig = params.generationConfig
      return {
        generateContentStream: async () => ({
          stream: (async function* () {
            yield { candidates: [{ content: { parts: [{ text: 'ok' }] } }] }
          })(),
          response: Promise.resolve({ usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } }),
        }),
      }
    }
  }
  return { GoogleGenerativeAI }
})

// ── OpenAI SDK mock (chat/completions — the OpenRouter dialect) ──────────────
const openAiCapture: { params?: Record<string, unknown> } = {}
vi.mock('openai', () => {
  class OpenAI {
    chat = {
      completions: {
        create: async (params: Record<string, unknown>) => {
          openAiCapture.params = params
          return (async function* () {
            yield { choices: [{ delta: { content: 'ok' } }] }
          })()
        },
      },
    }
    responses = {
      create: async () => { throw new Error('responses disabled in this test') },
    }
  }
  return { default: OpenAI }
})

async function drain(gen: AsyncGenerator<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

const BASE = {
  system: 'sys',
  messages: [{ role: 'user' as const, content: 'hi' }],
  tools: [],
}

beforeEach(() => {
  anthropicCapture.params = undefined
  googleCapture.generationConfig = undefined
  openAiCapture.params = undefined
  process.env.ANTHROPIC_API_KEY = 'test'
  process.env.OPENROUTER_API_KEY = 'test'
})

describe('Anthropic wire', () => {
  it('sends output_config.effort for a 4.6+ head', async () => {
    const { AnthropicAdapter } = await import('@/agent/lib/models/adapters/anthropic')
    await drain(new AnthropicAdapter().streamTurn({
      ...BASE, apiModel: 'claude-opus-4-8', thinking: 'adaptive',
      effort: 'max', effortDialect: 'anthropic_effort',
    }))
    expect(anthropicCapture.params?.output_config).toEqual({ effort: 'max' })
    expect(anthropicCapture.params?.thinking).toEqual({ type: 'adaptive' })
  })

  it('Auto sends NO output_config at all (request unchanged)', async () => {
    const { AnthropicAdapter } = await import('@/agent/lib/models/adapters/anthropic')
    await drain(new AnthropicAdapter().streamTurn({
      ...BASE, apiModel: 'claude-opus-4-8', thinking: 'adaptive',
      effort: null, effortDialect: 'anthropic_effort',
    }))
    expect(anthropicCapture.params).not.toHaveProperty('output_config')
    expect(anthropicCapture.params?.thinking).toEqual({ type: 'adaptive' })
  })

  it('Auto on the BUDGET dialect keeps the old request (no budget substituted)', async () => {
    const { AnthropicAdapter } = await import('@/agent/lib/models/adapters/anthropic')
    await drain(new AnthropicAdapter().streamTurn({
      ...BASE, apiModel: 'claude-haiku-4-5-20251001', thinking: 'adaptive',
      effort: null, effortDialect: 'anthropic_budget',
    }))
    expect(anthropicCapture.params?.thinking).toEqual({ type: 'adaptive' })
    expect(anthropicCapture.params).not.toHaveProperty('output_config')
  })

  it('a pre-4.6 head (Haiku 4.5) gets a thinking BUDGET, never output_config', async () => {
    const { AnthropicAdapter } = await import('@/agent/lib/models/adapters/anthropic')
    await drain(new AnthropicAdapter().streamTurn({
      ...BASE, apiModel: 'claude-haiku-4-5-20251001', thinking: 'adaptive',
      effort: 'high', effortDialect: 'anthropic_budget',
    }))
    expect(anthropicCapture.params).not.toHaveProperty('output_config')
    const thinking = anthropicCapture.params?.thinking as { type: string; budget_tokens: number }
    expect(thinking.type).toBe('enabled')
    expect(thinking.budget_tokens).toBeGreaterThanOrEqual(1024)
    expect(thinking.budget_tokens).toBeLessThan(anthropicCapture.params?.max_tokens as number)
  })
})

describe('Gemini wire', () => {
  it('sends thinkingLevel alongside includeThoughts', async () => {
    const { GoogleAdapter } = await import('@/agent/lib/models/adapters/google')
    await drain(new GoogleAdapter('k').streamTurn({
      ...BASE, apiModel: 'gemini-3.1-pro-preview', thinking: 'level',
      effort: 'low', effortDialect: 'gemini_thinking_level',
    }))
    expect(googleCapture.generationConfig?.thinkingConfig).toEqual({
      includeThoughts: true, thinkingLevel: 'low',
    })
  })

  it('Auto keeps the old thinkingConfig exactly (thoughts only)', async () => {
    const { GoogleAdapter } = await import('@/agent/lib/models/adapters/google')
    await drain(new GoogleAdapter('k').streamTurn({
      ...BASE, apiModel: 'gemini-3.1-pro-preview', thinking: 'level',
      effort: null, effortDialect: 'gemini_thinking_level',
    }))
    expect(googleCapture.generationConfig?.thinkingConfig).toEqual({ includeThoughts: true })
  })

  it('Gemini 2.5 gets a thinkingBUDGET — it 400s on thinkingLevel', async () => {
    const { GoogleAdapter } = await import('@/agent/lib/models/adapters/google')
    await drain(new GoogleAdapter('k').streamTurn({
      ...BASE, apiModel: 'gemini-2.5-flash', thinking: 'level',
      effort: 'high', effortDialect: 'gemini_thinking_budget',
    }))
    const cfg = googleCapture.generationConfig?.thinkingConfig as Record<string, unknown>
    const budget = cfg.thinkingBudget as number
    expect(budget).toBeGreaterThan(0)
    // Thinking is billed against the same output allowance as the answer.
    const cap = (googleCapture.generationConfig?.maxOutputTokens as number | undefined) ?? 8192
    expect(budget).toBeLessThan(cap)
    expect(cfg).not.toHaveProperty('thinkingLevel')
    expect(cfg.includeThoughts).toBe(true)
  })

  it('ignores a level resolved for ANOTHER provider (no guessing)', async () => {
    const { GoogleAdapter } = await import('@/agent/lib/models/adapters/google')
    await drain(new GoogleAdapter('k').streamTurn({
      ...BASE, apiModel: 'gemini-3.1-pro-preview', thinking: 'level',
      effort: 'xhigh', effortDialect: 'openai_effort',
    }))
    expect(googleCapture.generationConfig?.thinkingConfig).toEqual({ includeThoughts: true })
  })
})

describe('OpenRouter wire', () => {
  it('replaces the hard-coded medium with the owner\'s level', async () => {
    const { createOpenRouterAdapter } = await import('@/agent/lib/models/adapters/openrouter')
    await drain(createOpenRouterAdapter().streamTurn({
      ...BASE, apiModel: 'deepseek/deepseek-v4-flash', thinking: 'level',
      effort: 'high', effortDialect: 'openrouter_effort',
    }))
    expect(openAiCapture.params?.reasoning).toEqual({ enabled: true, effort: 'high' })
  })

  it('Auto still asks for the reasoning stream at the previous default', async () => {
    const { createOpenRouterAdapter } = await import('@/agent/lib/models/adapters/openrouter')
    await drain(createOpenRouterAdapter().streamTurn({
      ...BASE, apiModel: 'deepseek/deepseek-v4-flash', thinking: 'level',
      effort: null, effortDialect: 'openrouter_effort',
    }))
    expect(openAiCapture.params?.reasoning).toEqual({ enabled: true, effort: 'medium' })
  })
})
