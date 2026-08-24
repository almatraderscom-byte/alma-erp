import { describe, expect, it } from 'vitest'
import { IncrementalSseParser, type ParsedSseEvent } from '@/agent/lib/sse-parser'

const encode = (value: string) => new TextEncoder().encode(value)

function parseChunks(chunks: Uint8Array[]): ParsedSseEvent[] {
  const parser = new IncrementalSseParser()
  return [...chunks.flatMap((chunk) => parser.push(chunk)), ...parser.finish()]
}

describe('IncrementalSseParser', () => {
  const fixture = [
    ': proxy keepalive',
    'id: 208',
    'event: message',
    'data: {"type":"text_delta",',
    'data: "delta":"বাংলা ঠিক আছে"}',
    '',
    'id: 209',
    'data:{"type":"done","messageId":"assistant-1"}',
    '',
    '',
  ].join('\r\n')

  const expected = [
    {
      id: '208',
      event: 'message',
      data: '{"type":"text_delta",\n"delta":"বাংলা ঠিক আছে"}',
    },
    {
      id: '209',
      event: 'message',
      data: '{"type":"done","messageId":"assistant-1"}',
    },
  ]

  it('handles comments, id, CRLF, no-space fields and multiline data', () => {
    expect(parseChunks([encode(fixture)])).toEqual(expected)
  })

  it('produces the same events for every possible two-chunk byte split', () => {
    const bytes = encode(fixture)
    for (let split = 0; split <= bytes.length; split += 1) {
      expect(
        parseChunks([bytes.slice(0, split), bytes.slice(split)]),
        `split at byte ${split}`,
      ).toEqual(expected)
    }
  })

  it('handles one-byte chunks through a multi-byte UTF-8 payload', () => {
    const bytes = encode(fixture)
    expect(parseChunks(Array.from(bytes, (byte) => Uint8Array.of(byte)))).toEqual(expected)
  })

  it('flushes a complete trailing data frame at EOF without a blank delimiter', () => {
    expect(parseChunks([encode('id: 7\ndata: {"type":"done"}')])).toEqual([{
      id: '7', event: 'message', data: '{"type":"done"}',
    }])
  })

  it('ignores comments/unknown fields and retains the last valid event id', () => {
    expect(parseChunks([encode([
      'id: 10', '',
      ': ping',
      'unknown: ignored',
      'data: {"type":"turn_snapshot"}', '', '',
    ].join('\n'))])).toEqual([{
      id: '10', event: 'message', data: '{"type":"turn_snapshot"}',
    }])
  })
})
