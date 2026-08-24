import { describe, expect, it } from 'vitest'
import fixture from './fixtures/provider-protocol-d00c.json'
import type { ProviderAdapter, TurnEvent } from '@/agent/lib/models/types'
import { getModel } from '@/agent/lib/models/registry'
import { fnv1aHex } from '@/agent/lib/presentation/prose-lifecycle'
import {
  ProviderContentProtocolError,
  PROVIDER_PROTOCOL_CONFORMANCE,
  isExplicitOwnerProtocolPin,
  providerApi,
  protocolSafeFallback,
  withProviderProtocolNormalizer,
} from '@/agent/lib/models/provider-protocol'

async function collect(adapter: ProviderAdapter): Promise<TurnEvent[]> {
  const events: TurnEvent[] = []
  for await (const event of adapter.streamTurn({
    apiModel: fixture.incident.model,
    system: 'fixture',
    messages: [{ role: 'user', content: 'audit' }],
    tools: [{ name: 'fetch_website_page', description: 'read', schema: { type: 'object' } }],
  })) events.push(event)
  return events
}

function fixtureAdapter(events: TurnEvent[]): ProviderAdapter {
  return {
    async *streamTurn() {
      for (const event of events) yield event
    },
  }
}

describe('canonical provider protocol normalizer', () => {
  it('keeps the recorded fixture byte-exact to production event 214', () => {
    expect(fixture.incident.eventRange).toBe('209-212')
    expect(fixture.incident.chunks).toHaveLength(4)
    expect(fnv1aHex(fixture.incident.chunks.join(''))).toBe(fixture.incident.checksum)
  })

  it('quarantines the exact d00c content chunks and fails the zero-tool protocol', async () => {
    const raw: TurnEvent[] = [
      ...fixture.incident.chunks.map((text) => ({ type: 'text_delta' as const, text })),
      { type: 'done' },
    ]
    const adapter = withProviderProtocolNormalizer(fixtureAdapter(raw), {
      provider: 'openrouter',
      api: 'chat.completions',
    })

    await expect(collect(adapter)).rejects.toMatchObject({
      name: 'ProviderContentProtocolError',
      code: 'PROVIDER_CONTENT_TOOL_PROTOCOL',
      provider: 'openrouter',
      apiModel: fixture.incident.model,
    } satisfies Partial<ProviderContentProtocolError>)
  })

  it('preserves clean prose and real structured tool calls in a mixed response', async () => {
    const raw: TurnEvent[] = [
      { type: 'text_delta', text: 'Checking the page now.' },
      { type: 'tool_start', id: 'call-1', name: 'fetch_website_page' },
      { type: 'tool_input', id: 'call-1', input: { path: '/products/example' } },
      { type: 'done' },
    ]
    const adapter = withProviderProtocolNormalizer(fixtureAdapter(raw), {
      provider: 'openrouter',
      api: 'chat.completions',
    })

    await expect(collect(adapter)).resolves.toEqual(raw)
  })

  it('quarantines DSML content but preserves genuine structured calls in the same response', async () => {
    const raw: TurnEvent[] = [
      { type: 'text_delta', text: fixture.incident.chunks.join('') },
      { type: 'tool_start', id: 'call-real', name: 'fetch_website_page' },
      { type: 'tool_input', id: 'call-real', input: { path: '/products/example' } },
      { type: 'done' },
    ]
    const adapter = withProviderProtocolNormalizer(fixtureAdapter(raw), {
      provider: 'openrouter',
      api: 'chat.completions',
    })

    await expect(collect(adapter)).resolves.toEqual([
      { type: 'tool_start', id: 'call-real', name: 'fetch_website_page' },
      { type: 'tool_input', id: 'call-real', input: { path: '/products/example' } },
      { type: 'done' },
    ])
  })

  it('never promotes DSML content into executable tool events when real calls are absent', async () => {
    const raw: TurnEvent[] = [
      { type: 'text_delta', text: fixture.incident.chunks.join('') },
      { type: 'done' },
    ]
    const adapter = withProviderProtocolNormalizer(fixtureAdapter(raw), {
      provider: 'openrouter',
      api: 'chat.completions',
    })
    const seen: TurnEvent[] = []
    try {
      for await (const event of adapter.streamTurn({
        apiModel: fixture.incident.model,
        system: 'fixture',
        messages: [],
        tools: [],
      })) seen.push(event)
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderContentProtocolError)
    }
    expect(seen.filter((event) => event.type === 'tool_start' || event.type === 'tool_input')).toEqual([])
    expect(seen.filter((event) => event.type === 'text_delta')).toEqual([])
  })
})

describe('provider/model/API conformance and fail-closed fallback', () => {
  it('records production failure separately from unknown provider claims', () => {
    expect(PROVIDER_PROTOCOL_CONFORMANCE).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: 'openrouter',
        apiModel: 'deepseek/deepseek-v4-flash',
        api: 'chat.completions',
        state: 'quarantined',
        fixture: expect.stringContaining('d00c'),
      }),
      expect.objectContaining({ provider: 'openai', apiModel: 'gpt-5.6-luna', api: 'responses', state: 'unknown' }),
      expect.objectContaining({ provider: 'openai', apiModel: 'gpt-5.6-luna', api: 'chat.completions', state: 'unknown' }),
    ]))
  })

  it('reports both OpenAI bindings and resolves the runtime switch truthfully', () => {
    expect(providerApi('openai', { OPENAI_RESPONSES_API: 'false' })).toBe('chat.completions')
    expect(providerApi('openai', {})).toBe('responses-or-chat.completions')
    expect(PROVIDER_PROTOCOL_CONFORMANCE
      .filter((row) => row.modelId === 'gpt-5.6-luna')
      .map((row) => row.api))
      .toEqual(['responses', 'chat.completions'])
    expect(PROVIDER_PROTOCOL_CONFORMANCE.every((row) => row.checkedAt === '2026-08-23')).toBe(true)
  })

  it('uses a different-provider fallback for quarantined auto routing', () => {
    const failed = getModel('or-deepseek-v4-flash')
    const result = protocolSafeFallback(failed, { explicitOwnerPin: false })
    expect(result).not.toBeNull()
    expect(result?.from.id).toBe(failed.id)
    expect(result?.to.provider).not.toBe(failed.provider)
    expect(result?.to.id).toBe('gpt-5.6-luna')
  })

  it('never overrides an explicit owner pin', () => {
    expect(protocolSafeFallback(getModel('or-deepseek-v4-flash'), { explicitOwnerPin: true })).toBeNull()
    expect(isExplicitOwnerProtocolPin({ tier: 'explicit', via: 'explicit' })).toBe(true)
    expect(isExplicitOwnerProtocolPin({ tier: 'marketing', via: 'explicit_marketing' })).toBe(true)
    expect(isExplicitOwnerProtocolPin({ tier: 'light', via: 'routine_kw' })).toBe(false)
  })

  it('does not invent safety for unknown or verified-unrelated models', () => {
    expect(protocolSafeFallback(getModel('or-qwen3-max'), { explicitOwnerPin: false })).toBeNull()
    expect(protocolSafeFallback(getModel('gpt-5.6-luna'), { explicitOwnerPin: false })).toBeNull()
  })
})
