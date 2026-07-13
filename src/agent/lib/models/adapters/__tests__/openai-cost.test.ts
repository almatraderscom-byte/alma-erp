import { describe, it, expect, vi, beforeEach } from 'vitest'

// Capture the params the adapter sends to OpenRouter so we can assert the
// `usage: { include: true }` opt-in, and drive a fake streaming response back.
const createMock = vi.fn()

vi.mock('openai', () => {
  return {
    default: class FakeOpenAI {
      chat = { completions: { create: createMock } }
      constructor(_opts: unknown) {}
    },
  }
})

async function* fakeStream(chunks: unknown[]) {
  for (const c of chunks) yield c
}

// Import AFTER the mock is registered.
const { OpenAiAdapter } = await import('@/agent/lib/models/adapters/openai')

async function collectUsage(adapter: InstanceType<typeof OpenAiAdapter>) {
  const events: Array<{ type: string; costUsd?: number; inputTokens?: number; outputTokens?: number; cacheRead?: number }> = []
  for await (const ev of adapter.streamTurn({
    apiModel: 'x-ai/grok-4.20',
    system: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
  })) {
    events.push(ev as never)
  }
  return events.filter((e) => e.type === 'usage')
}

describe('OpenAiAdapter — OpenRouter actual cost passthrough', () => {
  beforeEach(() => {
    createMock.mockReset()
    delete process.env.OPENROUTER_INCLUDE_COST
  })

  it('opts into cost usage and surfaces usage.cost as costUsd (authoritative billed amount)', async () => {
    createMock.mockReturnValue(
      fakeStream([
        { choices: [{ delta: { content: 'hello' }, finish_reason: null }] },
        {
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 69_771,
            completion_tokens: 1_034,
            prompt_tokens_details: { cached_tokens: 62_000 },
            cost: 0.0202, // OpenRouter's real billed cost for this generation
          },
        },
      ]),
    )

    const adapter = new OpenAiAdapter('key', { includeCostUsage: true })
    const usage = await collectUsage(adapter)

    // The request must have opted into cost reporting.
    const sentParams = createMock.mock.calls[0][0] as { usage?: { include?: boolean } }
    expect(sentParams.usage).toEqual({ include: true })

    // The billed cost is surfaced verbatim — not recomputed from tokens.
    expect(usage).toHaveLength(1)
    expect(usage[0].costUsd).toBe(0.0202)
    // Tokens still reported as uncached-only input + cached read (unchanged behaviour).
    expect(usage[0].inputTokens).toBe(69_771 - 62_000)
    expect(usage[0].cacheRead).toBe(62_000)
    expect(usage[0].outputTokens).toBe(1_034)
  })

  it('leaves costUsd undefined when the provider reports no cost (→ caller estimates)', async () => {
    createMock.mockReturnValue(
      fakeStream([
        { choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } },
      ]),
    )
    const adapter = new OpenAiAdapter('key', { includeCostUsage: true })
    const usage = await collectUsage(adapter)
    expect(usage[0].costUsd).toBeUndefined()
  })

  it('ignores a zero/NaN cost so a bogus $0.00 never overrides the estimate', async () => {
    createMock.mockReturnValue(
      fakeStream([
        { choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0 } },
      ]),
    )
    const adapter = new OpenAiAdapter('key', { includeCostUsage: true })
    const usage = await collectUsage(adapter)
    expect(usage[0].costUsd).toBeUndefined()
  })

  it('does NOT opt into cost usage for raw OpenAI (includeCostUsage off)', async () => {
    createMock.mockReturnValue(
      fakeStream([{ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }]),
    )
    const adapter = new OpenAiAdapter('key', {})
    await collectUsage(adapter)
    const sentParams = createMock.mock.calls[0][0] as { usage?: unknown }
    expect(sentParams.usage).toBeUndefined()
  })

  it('respects the OPENROUTER_INCLUDE_COST=false kill switch', async () => {
    process.env.OPENROUTER_INCLUDE_COST = 'false'
    createMock.mockReturnValue(
      fakeStream([{ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, cost: 0.01 } }]),
    )
    const adapter = new OpenAiAdapter('key', { includeCostUsage: true })
    const usage = await collectUsage(adapter)
    const sentParams = createMock.mock.calls[0][0] as { usage?: unknown }
    expect(sentParams.usage).toBeUndefined()
    // With the opt-out, we neither request nor trust a cost field → caller estimates.
    expect(usage[0].costUsd).toBeUndefined()
  })
})
