import { describe, expect, it } from 'vitest'
import { buildLiveVoiceConfig, buildLiveVoiceTokenConfig, LIVE_VOICE_SYSTEM_INSTRUCTION } from '@/agent/lib/live-voice-config'

describe('live voice configuration', () => {
  it('uses native audio, server VAD, interruption, transcripts, and session resumption', () => {
    const config = buildLiveVoiceConfig('Charon')
    expect(config.responseModalities).toEqual(['AUDIO'])
    expect(config.inputAudioTranscription).toEqual({})
    expect(config.outputAudioTranscription).toEqual({})
    expect(config.sessionResumption).toEqual({})
    expect(config.realtimeInputConfig?.activityHandling).toBe('START_OF_ACTIVITY_INTERRUPTS')
    expect(config.realtimeInputConfig?.automaticActivityDetection?.disabled).toBe(false)
    expect(config.realtimeInputConfig?.automaticActivityDetection?.startOfSpeechSensitivity)
      .toBe('START_SENSITIVITY_LOW')
    expect(config.realtimeInputConfig?.automaticActivityDetection?.prefixPaddingMs).toBe(250)
    expect(config.realtimeInputConfig?.automaticActivityDetection?.silenceDurationMs).toBe(650)
  })

  it('server-locks transport policy while leaving resumption and the SDK-broken repeated tool mask client-settable', () => {
    expect(buildLiveVoiceConfig().sessionResumption).toEqual({})
    expect(buildLiveVoiceTokenConfig().sessionResumption).toBeUndefined()
    expect(buildLiveVoiceTokenConfig().systemInstruction).toBeTruthy()
    expect(buildLiveVoiceConfig().tools).toHaveLength(1)
    expect(buildLiveVoiceTokenConfig().tools).toBeUndefined()
  })

  it('forces owner requests through the existing head agent boundary', () => {
    const config = buildLiveVoiceConfig()
    const declarations = (config.tools?.[0] as { functionDeclarations?: Array<{ name?: string }> })
      ?.functionDeclarations ?? []
    expect(declarations.map((item) => item.name)).toContain('run_agent_turn')
    expect(LIVE_VOICE_SYSTEM_INSTRUCTION).toContain('প্রতিটি বক্তব্য বা অনুরোধে run_agent_turn')
    expect(LIVE_VOICE_SYSTEM_INSTRUCTION).toContain('completed/report-ready')
    expect(LIVE_VOICE_SYSTEM_INSTRUCTION).not.toContain('স্যার')
  })
})
