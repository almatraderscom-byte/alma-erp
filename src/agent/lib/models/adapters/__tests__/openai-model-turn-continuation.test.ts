import { describe, it, expect, vi, beforeEach } from 'vitest'

// Gemini 3.7 via OpenRouter rejects a request whose last message is an
// assistant turn (speak-first leaves exactly that shape). The adapter must
// append ONE internal-control user continuation and re-send the same rung —
// and keep it on every later rung — without touching requests that succeed.
const createMock = vi.fn()

vi.mock('openai', () => ({
  default: class FakeOpenAI {
    chat = { completions: { create: createMock } }
    constructor(_opts: unknown) {}
  },
}))

async function* fakeStream(chunks: unknown[]) {
  for (const c of chunks) yield c
}

const {
  OpenAiAdapter,
  MODEL_TURN_CONTINUATION,
  isTrailingModelTurnRejection,
  withModelTurnContinuation,
} = await import('@/agent/lib/models/adapters/openai')

const okStream = () => fakeStream([
  { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
])

function modelTurnError() {
  const err = new Error('400 Provider returned error') as Error & { status: number; error: unknown }
  err.status = 400
  err.error = { metadata: { raw: '{"error":{"code":400,"message":"Requests ending with a model turn are not supported.","status":"INVALID_ARGUMENT"}}' } }
  return err
}

async function run(adapter: InstanceType<typeof OpenAiAdapter>) {
  const out: string[] = []
  for await (const ev of adapter.streamTurn({
    apiModel: 'google/gemini-3.7-flash',
    system: 'sys',
    messages: [
      { role: 'user', content: 'stock e kon product kom?' },
      { role: 'assistant', content: 'বস, স্টক দেখছি।' },
    ],
    tools: [],
  })) {
    if (ev.type === 'text_delta') out.push(ev.text)
  }
  return out.join('')
}

describe('OpenAiAdapter — trailing model turn continuation', () => {
  beforeEach(() => createMock.mockReset())

  it('pure helpers: matcher + append only after an assistant tail', () => {
    expect(isTrailingModelTurnRejection('400 … Requests ending with a model turn are not supported.')).toBe(true)
    expect(isTrailingModelTurnRejection('404 No endpoints found')).toBe(false)
    const cont = { role: 'user', content: 'c' }
    expect(withModelTurnContinuation([{ role: 'user', content: 'u' }], cont)).toHaveLength(1)
    expect(withModelTurnContinuation([{ role: 'user', content: 'u' }, { role: 'assistant', content: 'a' }], cont)).toHaveLength(3)
  })

  it('re-sends the SAME rung with one continuation message after the exact 400', async () => {
    createMock.mockImplementationOnce(() => { throw modelTurnError() })
    createMock.mockImplementationOnce(() => okStream())
    const adapter = new OpenAiAdapter('key', { exacto: true, reasoning: true })
    expect(await run(adapter)).toBe('ok')
    expect(createMock).toHaveBeenCalledTimes(2)
    const first = createMock.mock.calls[0][0] as { model: string; messages: Array<{ role: string; content: unknown }>; reasoning?: unknown }
    const second = createMock.mock.calls[1][0] as typeof first
    // Same rung: model slug + reasoning extension untouched.
    expect(second.model).toBe(first.model)
    expect(second.reasoning).toEqual(first.reasoning)
    // One user continuation appended after the assistant tail — nothing else changed.
    expect(second.messages).toHaveLength(first.messages.length + 1)
    expect(second.messages.at(-1)).toEqual({ role: 'user', content: MODEL_TURN_CONTINUATION })
    expect(second.messages.at(-2)?.role).toBe('assistant')
  })

  it('keeps the continuation on later ladder rungs', async () => {
    createMock.mockImplementationOnce(() => { throw modelTurnError() })
    createMock.mockImplementationOnce(() => { throw Object.assign(new Error('400 reasoning not supported'), { status: 400 }) })
    createMock.mockImplementationOnce(() => okStream())
    const adapter = new OpenAiAdapter('key', { exacto: true, reasoning: true })
    expect(await run(adapter)).toBe('ok')
    expect(createMock).toHaveBeenCalledTimes(3)
    const third = createMock.mock.calls[2][0] as { messages: Array<{ role: string; content: unknown }> }
    expect(third.messages.at(-1)).toEqual({ role: 'user', content: MODEL_TURN_CONTINUATION })
    expect(third.messages.filter((m) => m.content === MODEL_TURN_CONTINUATION)).toHaveLength(1)
  })

  it('never reshapes a request the host accepts', async () => {
    createMock.mockImplementationOnce(() => okStream())
    const adapter = new OpenAiAdapter('key', {})
    expect(await run(adapter)).toBe('ok')
    const only = createMock.mock.calls[0][0] as { messages: Array<{ role: string }> }
    expect(only.messages.at(-1)?.role).toBe('assistant')
  })
})
