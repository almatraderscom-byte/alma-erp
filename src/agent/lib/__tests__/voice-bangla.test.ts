import { describe, it, expect, vi } from 'vitest'
import { transcribeVoiceBangla, BANGLA_STT_MODEL, WHISPER_BANGLA_PROMPT } from '@/agent/lib/voice-bangla'

// Minimal OpenAI client stub — we only exercise audio.transcriptions.create.
type CreateArgs = { model: string; language?: string; prompt?: string }
function makeClient(impl: (args: CreateArgs) => Promise<{ text: string }>) {
  const create = vi.fn(impl)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = { audio: { transcriptions: { create } } } as any
  return { client, create }
}

const fakeFile = { name: 'voice.ogg' } as unknown as Parameters<typeof transcribeVoiceBangla>[1]

describe('transcribeVoiceBangla', () => {
  it('defaults to the high-quality gpt-4o-transcribe model (not whisper-1)', () => {
    // Owner hit garbled Bangla on whisper-1; the permanent fix is gpt-4o-transcribe.
    expect(BANGLA_STT_MODEL).toBe('gpt-4o-transcribe')
  })

  it('transcribes with the primary model + Bangla language hint + anti-Hindi prompt', async () => {
    const { client, create } = makeClient(async () => ({ text: 'আসসালামু আলাইকুম' }))
    const out = await transcribeVoiceBangla(client, fakeFile)
    expect(out.text).toBe('আসসালামু আলাইকুম')
    expect(out.model).toBe('gpt-4o-transcribe')
    const args = create.mock.calls[0][0] as CreateArgs
    expect(args.model).toBe('gpt-4o-transcribe')
    expect(args.language).toBe('bn')
    expect(args.prompt).toBe(WHISPER_BANGLA_PROMPT)
  })

  it('retries the same model WITHOUT the language hint if the hint is rejected', async () => {
    let call = 0
    const { client, create } = makeClient(async (args) => {
      call++
      if (call === 1 && args.language === 'bn') throw new Error('language not supported')
      return { text: 'ঠিক আছে' }
    })
    const out = await transcribeVoiceBangla(client, fakeFile)
    expect(out.text).toBe('ঠিক আছে')
    expect(out.model).toBe('gpt-4o-transcribe')
    expect(create).toHaveBeenCalledTimes(2)
    expect((create.mock.calls[1][0] as CreateArgs).language).toBeUndefined()
  })

  it('falls back to whisper-1 only when the primary model is unavailable', async () => {
    const { client, create } = makeClient(async (args) => {
      if (args.model === 'gpt-4o-transcribe') throw new Error('The model `gpt-4o-transcribe` does not exist')
      return { text: 'whisper result' }
    })
    const out = await transcribeVoiceBangla(client, fakeFile)
    expect(out.model).toBe('whisper-1')
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'whisper-1', language: 'bn' }))
  })

  it('re-throws non-model errors (auth/network) instead of silently degrading', async () => {
    const { client } = makeClient(async () => { throw new Error('401 invalid api key') })
    await expect(transcribeVoiceBangla(client, fakeFile)).rejects.toThrow(/401/)
  })
})
