import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TurnEvent } from '@/agent/lib/models/types'

/**
 * Guards the owner-reported "visually stopped" fix: Gemini 3.x Pro is a THINKING
 * model that reasons SILENTLY for ~10s before its first answer token. Left to its
 * defaults the head streams nothing for that whole window, so the chat looks
 * frozen. The adapter now asks for `includeThoughts` and routes thought-summary
 * parts to `thinking_delta` (live "ভাবছি…" progress), while ordinary text stays
 * `text_delta`. It must ALSO degrade safely: if the preview model rejects the
 * thinkingConfig key, the turn still answers (never takes the live head down).
 */

// ---- mock the Google SDK ---------------------------------------------------
const capture: { generationConfig?: unknown; openCalls: number } = { openCalls: 0 }
// The stream each open() returns; tests swap this per-case.
let nextStream: () => AsyncGenerator<unknown>
let openBehaviour: (withThoughts: boolean) => void = () => {}

vi.mock('@google/generative-ai', () => {
  class GoogleGenerativeAI {
    constructor(_key: string) {}
    getGenerativeModel(params: { generationConfig?: unknown }) {
      capture.generationConfig = params.generationConfig
      const withThoughts = Boolean(
        (params.generationConfig as { thinkingConfig?: { includeThoughts?: boolean } } | undefined)
          ?.thinkingConfig?.includeThoughts,
      )
      return {
        generateContentStream: async () => {
          capture.openCalls += 1
          openBehaviour(withThoughts) // may throw to simulate a 400
          return {
            stream: nextStream(),
            response: Promise.resolve({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }),
          }
        },
      }
    }
  }
  return { GoogleGenerativeAI }
})

import { GoogleAdapter } from '@/agent/lib/models/adapters/google'

async function collect(gen: AsyncGenerator<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

function chunk(parts: unknown[]) {
  return { candidates: [{ content: { parts } }] }
}

beforeEach(() => {
  capture.generationConfig = undefined
  capture.openCalls = 0
  openBehaviour = () => {}
})

describe('GoogleAdapter — thinking stream', () => {
  it('requests includeThoughts and routes thought parts to thinking_delta, text to text_delta', async () => {
    nextStream = async function* () {
      yield chunk([{ text: 'let me check the numbers', thought: true }])
      yield chunk([{ text: 'স্যার, আজকের সেল ৳০', thought: false }])
    }
    const adapter = new GoogleAdapter('key')
    const events = await collect(
      adapter.streamTurn({ apiModel: 'gemini-3.1-pro-preview', system: 's', messages: [], tools: [], thinking: 'level' }),
    )

    // asked the API for thoughts
    expect(capture.generationConfig).toEqual({ thinkingConfig: { includeThoughts: true } })
    // thought part → thinking_delta (NOT mixed into the answer)
    expect(events).toContainEqual({ type: 'thinking_delta', text: 'let me check the numbers' })
    expect(events).toContainEqual({ type: 'text_delta', text: 'স্যার, আজকের সেল ৳০' })
    expect(events.at(-1)).toEqual({ type: 'done' })
  })

  it('does NOT request thoughts when thinking is "none"', async () => {
    nextStream = async function* () {
      yield chunk([{ text: 'hi' }])
    }
    const adapter = new GoogleAdapter('key')
    await collect(
      adapter.streamTurn({ apiModel: 'gemini-3.1-pro-preview', system: 's', messages: [], tools: [], thinking: 'none' }),
    )
    expect(capture.generationConfig).toBeUndefined()
  })

  it('falls back to a no-thoughts retry if the model rejects thinkingConfig (never takes the head down)', async () => {
    // First open (with thoughts) throws a 400; the retry (no thoughts) answers.
    openBehaviour = (withThoughts) => {
      if (withThoughts) throw new Error('Invalid value at generationConfig.thinkingConfig')
    }
    nextStream = async function* () {
      yield chunk([{ text: 'answer after clean retry' }])
    }
    const adapter = new GoogleAdapter('key')
    const events = await collect(
      adapter.streamTurn({ apiModel: 'gemini-3.1-pro-preview', system: 's', messages: [], tools: [], thinking: 'level' }),
    )
    expect(capture.openCalls).toBe(2) // retried once
    expect(events).toContainEqual({ type: 'text_delta', text: 'answer after clean retry' })
    expect(events.at(-1)).toEqual({ type: 'done' })
  })
})
