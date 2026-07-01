import { describe, it, expect } from 'vitest'
import { toGeminiContents } from '@/agent/lib/models/adapters/google'
import type { NeutralMsg } from '@/agent/lib/models/types'

describe('toGeminiContents — Gemini 3 thought signatures on the tool-call follow-up', () => {
  it('echoes the thoughtSignature back on the functionCall part (round-2 request)', () => {
    // The exact multi-round shape that 400'd the head: an assistant tool-call turn
    // followed by its tool result. Gemini 3 requires the signature it attached to
    // the functionCall to be returned verbatim on the follow-up request.
    const messages: NeutralMsg[] = [
      { role: 'user', content: 'গত মাসের বিক্রি দেখাও' },
      {
        role: 'assistant',
        toolCalls: [{ id: 'c1', name: 'query_sales', input: { month: 'june' }, thoughtSignature: 'SIG_ABC' }],
      },
      { role: 'tool', toolCallId: 'c1', name: 'query_sales', result: { total: 1200 } },
    ]

    const contents = toGeminiContents(messages)
    const modelTurn = contents.find((c) => c.role === 'model')
    const part = modelTurn?.parts[0] as { functionCall?: unknown; thoughtSignature?: string }

    expect(part.functionCall).toEqual({ name: 'query_sales', args: { month: 'june' } })
    expect(part.thoughtSignature).toBe('SIG_ABC')
  })

  it('preserves per-part signatures for parallel tool calls (echoes exactly what was received)', () => {
    const messages: NeutralMsg[] = [
      {
        role: 'assistant',
        toolCalls: [
          { id: 'c1', name: 'a', input: {}, thoughtSignature: 'SIG_1' },
          { id: 'c2', name: 'b', input: {} },
        ],
      },
    ]

    const parts = toGeminiContents(messages)[0].parts as Array<{ thoughtSignature?: string }>
    expect(parts[0].thoughtSignature).toBe('SIG_1')
    expect(parts[1].thoughtSignature).toBeUndefined()
  })

  it('omits the thoughtSignature key entirely when the model did not attach one', () => {
    const messages: NeutralMsg[] = [
      { role: 'assistant', toolCalls: [{ id: 'c1', name: 'noop', input: {} }] },
    ]

    const part = toGeminiContents(messages)[0].parts[0] as unknown as Record<string, unknown>
    expect('thoughtSignature' in part).toBe(false)
  })
})
