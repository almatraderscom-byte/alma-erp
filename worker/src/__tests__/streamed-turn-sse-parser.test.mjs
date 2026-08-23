import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseSseJsonEvents } from '../turn/run-streamed-turn.mjs'

const encoder = new TextEncoder()

const expected = [
  { type: 'text_delta', delta: 'বাংলা ✅', blockId: 'turn:p8' },
  { type: 'done', messageId: 'message-1' },
]

function fixture(newline) {
  return [
    ': keepalive',
    'id: 208',
    'event: message',
    'data: {"type":"text_delta",',
    'data: "delta":"বাংলা ✅","blockId":"turn:p8"}',
    '',
    ': another comment',
    'id: 214',
    'data: {"type":"done","messageId":"message-1"}',
  ].join(newline) // Intentionally no final newline/blank line.
}
async function collect(chunks) {
  async function* body() {
    for (const chunk of chunks) yield chunk
  }
  const events = []
  for await (const event of parseSseJsonEvents(body())) events.push(event)
  return events
}

function chunksAtEveryBoundary(bytes) {
  const cases = [[bytes], Array.from(bytes, (_byte, index) => bytes.slice(index, index + 1))]
  for (let cut = 1; cut < bytes.length; cut += 1) {
    cases.push([bytes.slice(0, cut), bytes.slice(cut)])
  }
  return cases
}

for (const [label, newline] of [['LF', '\n'], ['CRLF', '\r\n']]) {
  test(`${label}: comments/id are ignored, multiline data is joined, and an unterminated final event is flushed`, async () => {
    const bytes = encoder.encode(fixture(newline))
    assert.deepEqual(await collect([bytes]), expected)
  })

  test(`${label}: parsing is invariant at every byte split, including inside Bengali UTF-8`, async () => {
    const bytes = encoder.encode(fixture(newline))
    for (const chunks of chunksAtEveryBoundary(bytes)) {
      assert.deepEqual(await collect(chunks), expected)
    }
  })
}
