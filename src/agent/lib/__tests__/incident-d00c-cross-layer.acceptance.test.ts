import { beforeEach, describe, expect, it, vi } from 'vitest'
import fixture from '@/agent/lib/models/__tests__/fixtures/provider-protocol-d00c.json'
import { IncrementalSseParser } from '@/agent/lib/sse-parser'
import {
  ProviderContentProtocolError,
  withProviderProtocolNormalizer,
} from '@/agent/lib/models/provider-protocol'
import {
  PROSE_PROTOCOL_V2,
  ProseLifecycleTracker,
  fnv1aHex,
} from '@/agent/lib/presentation/prose-lifecycle'
import { containsProviderToolProtocolSyntax } from '@/agent/lib/model-output-sanitize'
import type { TurnEvent } from '@/agent/lib/models/types'

/**
 * Production incident d00c1a82 — exact cross-layer acceptance.
 *
 * The audited failure was NOT one bad layer. The provider committed its tool
 * protocol as CONTENT (events 209–212, commit 214), and every layer downstream
 * treated it as owner prose: it reached the wire, the presentation document
 * (block p8) and the persisted transcript, while zero provider-native
 * `tool_start` / `tool_input` ever existed.
 *
 * This test drives the whole chain from the raw SSE bytes:
 *
 *   raw chat.completions SSE bytes
 *     → IncrementalSseParser
 *     → the REAL OpenAiAdapter chat/completions mapping (OpenRouter dialect)
 *     → withProviderProtocolNormalizer
 *     → ProseLifecycleTracker document (persistence authority)
 *
 * Only the recorded fixture payloads are used. Events 208 and 213 were not
 * captured with byte-exact payloads in the audit, so nothing stands in for
 * them: the envelope carries the four recorded content frames plus the
 * protocol-mandatory terminator.
 */

// The SDK is the only layer between the socket and the adapter mapping. It is
// replaced with a pass-through over chunks the incident's own SSE bytes parsed
// into, so the adapter under test runs its real code on real production data.
const sdkFeed: { chunks: unknown[] } = { chunks: [] }
const sdkCalls: { params: Record<string, unknown>[] } = { params: [] }

vi.mock('openai', () => {
  class OpenAI {
    chat = {
      completions: {
        create: async (params: Record<string, unknown>) => {
          sdkCalls.params.push(params)
          const chunks = sdkFeed.chunks
          return (async function* () {
            for (const chunk of chunks) yield chunk
          })()
        },
      },
    }
    responses = {
      create: async () => { throw new Error('responses API is not the incident binding') },
    }
  }
  return { default: OpenAI }
})

const INCIDENT = fixture.incident
const TURN_ID = INCIDENT.turnId

/** Exact OpenRouter/DeepSeek chat.completions SSE envelope for the recorded frames. */
function incidentSseBytes(): Uint8Array {
  const frames = INCIDENT.chunks.map((content, index) => JSON.stringify({
    id: `chatcmpl-${TURN_ID}`,
    object: 'chat.completion.chunk',
    model: INCIDENT.model,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
    // The audit recorded zero structured tool calls on every frame.
    ...(index === 0 ? { created: 0 } : {}),
  }))
  frames.push(JSON.stringify({
    id: `chatcmpl-${TURN_ID}`,
    object: 'chat.completion.chunk',
    model: INCIDENT.model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  }))
  const body = frames.map((frame) => `data: ${frame}\n\n`).join('') + 'data: [DONE]\n\n'
  return new TextEncoder().encode(body)
}

/** Parse bytes with the production SSE parser, split at the given offsets. */
function parseSse(bytes: Uint8Array, splits: number[]): string[] {
  const parser = new IncrementalSseParser()
  const out: string[] = []
  let cursor = 0
  for (const split of [...splits, bytes.length]) {
    const end = Math.min(Math.max(split, cursor), bytes.length)
    if (end > cursor) {
      for (const event of parser.push(bytes.subarray(cursor, end))) out.push(event.data)
      cursor = end
    }
  }
  for (const event of parser.finish()) out.push(event.data)
  return out
}

/** SSE `data:` payloads → the object stream the OpenAI SDK hands the adapter. */
function toSdkChunks(dataLines: string[]): unknown[] {
  return dataLines
    .filter((data) => data !== '[DONE]')
    .map((data) => JSON.parse(data) as unknown)
}

async function runAdapterChain(chunks: unknown[]): Promise<{ events: TurnEvent[]; error: unknown }> {
  sdkFeed.chunks = chunks
  process.env.OPENROUTER_API_KEY = 'test-key-not-a-secret'
  const { createOpenRouterAdapter } = await import('@/agent/lib/models/adapters/openrouter')
  const adapter = withProviderProtocolNormalizer(createOpenRouterAdapter(), {
    provider: 'openrouter',
    api: 'chat.completions',
  })
  const events: TurnEvent[] = []
  let error: unknown = null
  try {
    for await (const event of adapter.streamTurn({
      apiModel: INCIDENT.model,
      system: 'incident replay',
      messages: [{ role: 'user', content: 'audit the site' }],
      tools: [{ name: 'fetch_website_page', description: 'read a page', schema: { type: 'object' } }],
    })) events.push(event)
  } catch (err) {
    error = err
  }
  return { events, error }
}

beforeEach(() => {
  sdkCalls.params = []
  sdkFeed.chunks = []
})

describe('d00c events 209-214: SSE parser → provider normalizer', () => {
  it('keeps the recorded envelope byte-exact', () => {
    expect(INCIDENT.eventRange).toBe('209-212')
    expect(INCIDENT.commitEvent).toBe(214)
    expect(INCIDENT.structuredToolCalls).toEqual([])
    expect(fnv1aHex(INCIDENT.chunks.join(''))).toBe(INCIDENT.checksum)
  })

  it('parses the identical frames at EVERY byte boundary of the SSE envelope', () => {
    const bytes = incidentSseBytes()
    const whole = parseSse(bytes, [])
    expect(whole).toHaveLength(INCIDENT.chunks.length + 2) // frames + finish + [DONE]

    for (let split = 0; split <= bytes.length; split += 1) {
      expect(parseSse(bytes, [split])).toEqual(whole)
    }
    // And the pathological case: one byte per network read.
    const perByte = parseSse(bytes, Array.from({ length: bytes.length }, (_, i) => i))
    expect(perByte).toEqual(whole)

    // The recorded content survives the transport byte-for-byte.
    const contents = toSdkChunks(whole).map(
      (chunk) => (chunk as { choices: [{ delta: { content?: string } }] }).choices[0].delta.content,
    )
    expect(contents.slice(0, INCIDENT.chunks.length)).toEqual(INCIDENT.chunks)
  })

  it('emits zero provider-native tool events and quarantines the whole response', async () => {
    const bytes = incidentSseBytes()
    const { events, error } = await runAdapterChain(toSdkChunks(parseSse(bytes, [])))

    expect(error).toBeInstanceOf(ProviderContentProtocolError)
    expect(error).toMatchObject({
      code: 'PROVIDER_CONTENT_TOOL_PROTOCOL',
      provider: 'openrouter',
      apiModel: INCIDENT.model,
    })
    expect(events.filter((event) => event.type === 'tool_start')).toEqual([])
    expect(events.filter((event) => event.type === 'tool_input')).toEqual([])
    // Nothing owner-visible escaped: the machine syntax was held, never flushed.
    expect(events.filter((event) => event.type === 'text_delta')).toEqual([])
    expect(events.some((event) => event.type === 'done')).toBe(false)
    // The request itself was a normal tool-bearing call — the failure is the
    // response protocol, not a missing tool definition.
    expect(sdkCalls.params[0]).toMatchObject({ stream: true })
    // OpenRouter Exacto appends a routing suffix; the base binding is the
    // quarantined incident model either way.
    expect(String(sdkCalls.params[0].model).startsWith(INCIDENT.model)).toBe(true)
  })

  it('quarantines identically no matter where the socket split the bytes', async () => {
    const bytes = incidentSseBytes()
    // Sweep every boundary; each split must produce the identical quarantine.
    for (let split = 0; split <= bytes.length; split += 1) {
      const { events, error } = await runAdapterChain(toSdkChunks(parseSse(bytes, [split])))
      expect(error).toBeInstanceOf(ProviderContentProtocolError)
      expect(events.filter((e) => e.type === 'text_delta' || e.type === 'tool_start' || e.type === 'tool_input'))
        .toEqual([])
    }
  })
})

describe('d00c commit event 214: ProseLifecycle + persistence', () => {
  /** Drive the tracker to the incident's literal block position (p8). */
  function trackerAtP8() {
    const tracker = new ProseLifecycleTracker({ protocol: PROSE_PROTOCOL_V2, turnId: TURN_ID })
    // Blocks p1..p7 are ordinary prose/tool rounds. Each tool_start commits the
    // open block, so seven prose+tool rounds put the next block at p8.
    for (let round = 1; round <= 7; round += 1) {
      tracker.process({ type: 'text_delta', delta: `round ${round} update` })
      tracker.process({ type: 'tool_start', id: `call-${round}`, name: 'fetch_website_page' })
      tracker.process({ type: 'tool_end', id: `call-${round}` })
    }
    return tracker
  }

  it('opens the incident block at the literal id p8', () => {
    const tracker = trackerAtP8()
    const out = tracker.process({ type: 'text_delta', delta: 'next' })
    const start = out.find((event) => event.type === 'prose_start')
    expect(start?.blockId).toBe(`${TURN_ID}:p8`)
    expect(String(start?.blockId).endsWith(`:${INCIDENT.presentationBlock}`)).toBe(true)
  })

  it('persists nothing at p8 when the normalizer runs in front of it (production order)', async () => {
    const { events, error } = await runAdapterChain(toSdkChunks(parseSse(incidentSseBytes(), [])))
    expect(error).toBeInstanceOf(ProviderContentProtocolError)

    // The runner only ever forwards what the normalizer emitted. For this
    // response that is nothing, so the incident block never even opens.
    const tracker = trackerAtP8()
    const wire = events
      .filter((event): event is Extract<TurnEvent, { type: 'text_delta' }> => event.type === 'text_delta')
      .flatMap((event) => tracker.process({ type: 'text_delta', delta: event.text }))
    expect(wire).toEqual([])

    tracker.process({ type: 'done' })
    const document = tracker.document('message-d00c')
    expect(document.blocks.some((block) => block.id === `${TURN_ID}:${INCIDENT.presentationBlock}`)).toBe(false)
    const persisted = JSON.stringify(document)
    expect(containsProviderToolProtocolSyntax(persisted)).toBe(false)
    expect(persisted).not.toContain('smart-murda-moshari')
    expect(tracker.ownerVisibleText()).not.toContain('DSML')
  })

  it('never persists DSML at p8 even if the deltas reach the tracker directly', () => {
    // Defense in depth: the normalizer above is the primary guard, but the
    // presentation document is the READ-TIME authority for cold reload and iOS,
    // so it must be clean on its own.
    const tracker = trackerAtP8()
    const wire = INCIDENT.chunks.flatMap((chunk) => tracker.process({ type: 'text_delta', delta: chunk }))
    const settle = tracker.process({ type: 'done' })
    expect(wire.some((event) => event.type === 'prose_start' && event.blockId === `${TURN_ID}:p8`)).toBe(true)

    const document = tracker.document('message-d00c')
    const p8 = document.blocks.find((block) => block.id === `${TURN_ID}:p8`)
    // An all-markup block strips to nothing and is retired, never committed as prose.
    expect(p8?.state ?? 'absent').not.toBe('committed')
    expect(p8?.text ?? '').toBe('')
    expect(containsProviderToolProtocolSyntax(p8?.text ?? '')).toBe(false)

    const persisted = JSON.stringify(document)
    expect(containsProviderToolProtocolSyntax(persisted)).toBe(false)
    expect(persisted).not.toContain('DSML')
    expect(persisted).not.toContain('smart-murda-moshari')

    // Nothing owner-visible, live or cold.
    expect(tracker.ownerVisibleText().trim()).not.toContain('DSML')
    expect(containsProviderToolProtocolSyntax(tracker.ownerVisibleText())).toBe(false)
    expect(settle.some((event) => event.type === 'prose_commit' && event.blockId === `${TURN_ID}:p8`)).toBe(false)
  })
})
