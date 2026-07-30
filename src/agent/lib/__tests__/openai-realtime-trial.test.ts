import { describe, expect, it } from 'vitest'
import {
  buildOpenAIRealtimeTrialSession,
  isOpenAIRealtimeTrialEnabled,
  OPENAI_REALTIME_TRIAL_MODEL,
  parseOpenAIRealtimeTrialVoice,
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

  it('accepts only the two trial voices and safely defaults to cedar', () => {
    expect(parseOpenAIRealtimeTrialVoice('marin')).toBe('marin')
    expect(parseOpenAIRealtimeTrialVoice('cedar')).toBe('cedar')
    expect(parseOpenAIRealtimeTrialVoice('alloy')).toBe('cedar')
    expect(parseOpenAIRealtimeTrialVoice(null)).toBe('cedar')
  })

  it('builds a speech-to-speech session with semantic interruption handling', () => {
    const session = buildOpenAIRealtimeTrialSession('marin')
    expect(session.model).toBe(OPENAI_REALTIME_TRIAL_MODEL)
    expect(session.output_modalities).toEqual(['audio'])
    expect(session.audio.output.voice).toBe('marin')
    expect(session.audio.input.turn_detection).toMatchObject({
      type: 'semantic_vad',
      eagerness: 'low',
      create_response: true,
      interrupt_response: true,
    })
    expect(session.instructions).toContain('Boss')
    expect(session.instructions).toContain('voice-quality trial only')
  })
})
