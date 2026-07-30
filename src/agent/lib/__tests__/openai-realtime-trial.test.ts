import { describe, expect, it } from 'vitest'
import {
  buildOpenAIRealtimeTrialSession,
  isOpenAIRealtimeTrialEnabled,
  OPENAI_REALTIME_TRIAL_MODEL,
  parseOpenAIRealtimeInputProfile,
  parseOpenAIRealtimeTrialVoice,
  selectPreferredAudioInput,
} from '@/agent/lib/openai-realtime-trial'

describe('OpenAI Realtime voice trial', () => {
  it('is on by default only for development and Vercel previews', () => {
    expect(isOpenAIRealtimeTrialEnabled({ NODE_ENV: 'development' })).toBe(true)
    expect(isOpenAIRealtimeTrialEnabled({ VERCEL_ENV: 'preview', NODE_ENV: 'production' })).toBe(true)
    expect(isOpenAIRealtimeTrialEnabled({ VERCEL_ENV: 'production', NODE_ENV: 'production' })).toBe(false)
  })

  it('honors the explicit kill switch in every environment', () => {
    expect(isOpenAIRealtimeTrialEnabled({
      OPENAI_REALTIME_TRIAL_ENABLED: 'false',
      VERCEL_ENV: 'preview',
    })).toBe(false)
    expect(isOpenAIRealtimeTrialEnabled({
      OPENAI_REALTIME_TRIAL_ENABLED: 'true',
      VERCEL_ENV: 'production',
    })).toBe(true)
  })

  it('accepts only the two trial voices and safely defaults to Marin', () => {
    expect(parseOpenAIRealtimeTrialVoice('marin')).toBe('marin')
    expect(parseOpenAIRealtimeTrialVoice('cedar')).toBe('cedar')
    expect(parseOpenAIRealtimeTrialVoice('alloy')).toBe('marin')
    expect(parseOpenAIRealtimeTrialVoice(null)).toBe('marin')
  })

  it('selects device-aware OpenAI noise-reduction profiles safely', () => {
    expect(parseOpenAIRealtimeInputProfile('near_field')).toBe('near_field')
    expect(parseOpenAIRealtimeInputProfile('far_field')).toBe('far_field')
    expect(parseOpenAIRealtimeInputProfile('invalid')).toBe('far_field')
    expect(parseOpenAIRealtimeInputProfile(null)).toBe('far_field')
  })

  it('replaces a silent-prone Continuity mic with the built-in Mac microphone', () => {
    const devices = [
      { kind: 'audioinput', label: 'iPhone Microphone', deviceId: 'iphone' },
      { kind: 'audioinput', label: 'MacBook Pro Microphone', deviceId: 'macbook' },
      { kind: 'videoinput', label: 'FaceTime Camera', deviceId: 'camera' },
    ]

    expect(selectPreferredAudioInput(devices, 'iPhone Microphone')).toBe('macbook')
    expect(selectPreferredAudioInput(devices, 'MacBook Pro Microphone')).toBeNull()
    expect(selectPreferredAudioInput(devices, 'AirPods Microphone')).toBeNull()
  })

  it('builds a Bangla speech-to-speech session with responsive VAD and diagnostics', () => {
    const session = buildOpenAIRealtimeTrialSession('marin', 'near_field')
    expect(session.model).toBe(OPENAI_REALTIME_TRIAL_MODEL)
    expect(session.output_modalities).toEqual(['audio'])
    expect(session.audio.output.voice).toBe('marin')
    expect(session.audio.input.noise_reduction).toEqual({ type: 'near_field' })
    expect(session.audio.input.transcription).toMatchObject({
      model: 'gpt-4o-transcribe',
      language: 'bn',
    })
    expect(session.audio.input.turn_detection).toMatchObject({
      type: 'server_vad',
      threshold: 0.4,
      prefix_padding_ms: 300,
      silence_duration_ms: 600,
      create_response: true,
      interrupt_response: true,
    })
    expect(session.instructions).toContain('Boss')
    expect(session.instructions).toContain('বাংলাদেশি উচ্চারণ')
    expect(session.instructions).toContain('English vowel shaping')
  })
})
