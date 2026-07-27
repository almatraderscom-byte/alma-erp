/**
 * Cost audit Phase 8 — xAI sticky prompt-cache routing.
 *
 * xAI stores prompt-cache entries PER SERVER and documents `x-grok-conv-id` as
 * the way to keep one conversation pinned to the server holding its prefix
 * (docs.x.ai/developers/advanced-api-usage/prompt-caching). The xAI factory was
 * constructed with `baseURL` only — no headers — so consecutive turns could land
 * on a cold server and re-pay full input price for an identical prefix.
 *
 * These lock down: the header IS sent for xAI, is NOT sent for plain OpenAI /
 * OpenRouter (their request bytes must stay identical), and can be killed via env.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

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

const { OpenAiAdapter } = await import('@/agent/lib/models/adapters/openai')

/** Drain a turn and return the per-request options the adapter passed to create(). */
async function reqOptionsFor(
  adapter: InstanceType<typeof OpenAiAdapter>,
  args: { cacheKey?: string } = {},
) {
  createMock.mockReturnValue(
    fakeStream([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
  )
  for await (const _ of adapter.streamTurn({
    apiModel: 'grok-4.20',
    system: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    ...args,
  })) { /* drain */ }
  return createMock.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined
}

describe('xAI sticky cache header', () => {
  beforeEach(() => {
    createMock.mockReset()
    delete process.env.XAI_STICKY_CACHE
  })

  it('sends x-grok-conv-id when the factory opts in and a cacheKey is given', async () => {
    const adapter = new OpenAiAdapter('k', { baseURL: 'https://api.x.ai/v1', stickyCacheHeader: true })
    const opts = await reqOptionsFor(adapter, { cacheKey: 'conv-abc-123' })
    expect(opts?.headers?.['x-grok-conv-id']).toBe('conv-abc-123')
  })

  it('sends NO header when there is no cacheKey (nothing to pin to)', async () => {
    const adapter = new OpenAiAdapter('k', { baseURL: 'https://api.x.ai/v1', stickyCacheHeader: true })
    const opts = await reqOptionsFor(adapter)
    expect(opts?.headers).toBeUndefined()
  })

  it('does NOT send the header for non-xAI factories even with a cacheKey', async () => {
    const adapter = new OpenAiAdapter('k') // plain OpenAI / OpenRouter shape
    const opts = await reqOptionsFor(adapter, { cacheKey: 'conv-abc-123' })
    expect(opts?.headers).toBeUndefined()
  })

  it('XAI_STICKY_CACHE=false is an instant kill switch', async () => {
    process.env.XAI_STICKY_CACHE = 'false'
    const adapter = new OpenAiAdapter('k', { baseURL: 'https://api.x.ai/v1', stickyCacheHeader: true })
    const opts = await reqOptionsFor(adapter, { cacheKey: 'conv-abc-123' })
    expect(opts?.headers).toBeUndefined()
  })

  it('still forwards the abort signal alongside the header', async () => {
    const adapter = new OpenAiAdapter('k', { baseURL: 'https://api.x.ai/v1', stickyCacheHeader: true })
    createMock.mockReturnValue(
      fakeStream([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
    )
    const controller = new AbortController()
    for await (const _ of adapter.streamTurn({
      apiModel: 'grok-4.20',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      signal: controller.signal,
      cacheKey: 'conv-xyz',
    })) { /* drain */ }
    const opts = createMock.mock.calls[0]?.[1] as { headers?: Record<string, string>; signal?: AbortSignal }
    expect(opts?.headers?.['x-grok-conv-id']).toBe('conv-xyz')
    expect(opts?.signal).toBe(controller.signal)
  })
})
