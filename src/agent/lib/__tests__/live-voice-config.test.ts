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
  })

  it('server-locks the transport policy while leaving the resumption handle client-settable', () => {
    expect(buildLiveVoiceConfig().sessionResumption).toEqual({})
    expect(buildLiveVoiceTokenConfig().sessionResumption).toBeUndefined()
    expect(buildLiveVoiceTokenConfig().systemInstruction).toBeTruthy()
    expect(buildLiveVoiceTokenConfig().tools).toHaveLength(1)
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
