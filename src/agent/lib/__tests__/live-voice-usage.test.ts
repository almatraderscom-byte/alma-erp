import { describe, expect, it } from 'vitest'
import {
  liveVoiceUsageDedupKey,
  parseLiveVoiceUsageReport,
  priceLiveVoiceUsageSegment,
  type LiveVoiceUsageSegment,
} from '@/agent/lib/live-voice-usage'
import { GEMINI_25_LIVE_MODEL, GEMINI_31_LIVE_MODEL } from '@/agent/lib/live-voice-config'

function segment(overrides: Partial<LiveVoiceUsageSegment> = {}): LiveVoiceUsageSegment {
  return {
    model: GEMINI_25_LIVE_MODEL,
    voice: 'Aoede',
    inputAudioQueuedBytes: 0,
    outputAudioReceivedBytes: 0,
    inputTranscriptionCharacters: 0,
    outputTranscriptionCharacters: 0,
    providerUsage: {
      inputAudioTokens: 0,
      outputAudioTokens: 0,
      inputTextTokens: 0,
      outputTextTokens: 0,
      inputTotalTokens: 0,
      outputTotalTokens: 0,
    },
    ...overrides,
  }
}

describe('live voice usage pricing', () => {
  it('prices Gemini 2.5 provider modality tokens exactly', () => {
    const priced = priceLiveVoiceUsageSegment(segment({
      providerUsage: {
        inputAudioTokens: 1_000_000,
        outputAudioTokens: 1_000_000,
        inputTextTokens: 1_000_000,
        outputTextTokens: 1_000_000,
        inputTotalTokens: 2_000_000,
        outputTotalTokens: 2_000_000,
      },
    }))
    expect(priced.costUsd).toBe(17.5)
    expect(priced.units.input_audio_source).toBe('provider_usage_metadata')
  })

  it('uses Gemini 3.1 text rates', () => {
    const priced = priceLiveVoiceUsageSegment(segment({
      model: GEMINI_31_LIVE_MODEL,
      providerUsage: {
        inputAudioTokens: 0,
        outputAudioTokens: 0,
        inputTextTokens: 1_000_000,
        outputTextTokens: 1_000_000,
        inputTotalTokens: 1_000_000,
        outputTotalTokens: 1_000_000,
      },
    }))
    expect(priced.costUsd).toBe(5.25)
  })

  it('labels measured PCM fallback instead of claiming provider acceptance', () => {
    const priced = priceLiveVoiceUsageSegment(segment({
      inputAudioQueuedBytes: 16_000 * 2 * 40,
      outputAudioReceivedBytes: 24_000 * 2 * 20,
    }))
    expect(priced.costUsd).toBeCloseTo(0.009, 10)
    expect(priced.units.input_audio_source).toBe('local_queued_pcm_25_tokens_per_second')
    expect(priced.units.output_audio_source).toBe('local_received_pcm_25_tokens_per_second')
  })

  it('does not silently estimate transcription tokens from characters', () => {
    const priced = priceLiveVoiceUsageSegment(segment({
      inputTranscriptionCharacters: 100,
      outputTranscriptionCharacters: 200,
    }))
    expect(priced.unresolvedTranscription).toBe(true)
    expect(priced.units.transcription_token_source).toBe('unresolved_no_provider_modality_tokens')
    expect(priced.costUsd).toBe(0)
  })

  it('validates closed model, voice, units, and stable call identity', () => {
    const valid = {
      callId: 'call-usage-123',
      conversationId: null,
      segments: [segment()],
    }
    expect(parseLiveVoiceUsageReport(valid).ok).toBe(true)
    expect(parseLiveVoiceUsageReport({ ...valid, segments: [segment({ model: 'unknown' })] }))
      .toEqual({ ok: false, error: 'model_invalid' })
    expect(parseLiveVoiceUsageReport({ ...valid, segments: [segment({ voice: 'Unknown' })] }))
      .toEqual({ ok: false, error: 'voice_invalid' })
    expect(parseLiveVoiceUsageReport({
      ...valid,
      segments: [segment({ inputAudioQueuedBytes: -1 })],
    })).toEqual({ ok: false, error: 'segment_units_invalid' })
    expect(liveVoiceUsageDedupKey('owner-1', 'call-usage-123', 0))
      .toBe('live-voice:owner-1:call-usage-123:0')
  })
})
