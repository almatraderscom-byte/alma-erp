import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildLiveVoiceConfig,
  buildLiveVoiceTokenConfig,
  DEFAULT_LIVE_VOICE_MODEL,
  DEFAULT_LIVE_VOICE_NAME,
  GEMINI_25_LIVE_MODEL,
  GEMINI_31_LIVE_MODEL,
  isSupportedLiveVoiceModel,
  isSupportedLiveVoiceName,
  LIVE_VOICE_MODEL_IDS,
  LIVE_VOICE_NAMES,
  LIVE_VOICE_SYSTEM_INSTRUCTION,
} from '@/agent/lib/live-voice-config'

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
    expect(config.realtimeInputConfig?.automaticActivityDetection?.endOfSpeechSensitivity)
      .toBe('END_SENSITIVITY_LOW')
    expect(config.realtimeInputConfig?.automaticActivityDetection?.silenceDurationMs).toBe(1200)
  })

  it('server-locks transport policy while leaving resumption and the SDK-broken repeated tool mask client-settable', () => {
    expect(buildLiveVoiceConfig().sessionResumption).toEqual({})
    expect(buildLiveVoiceTokenConfig().sessionResumption).toBeUndefined()
    expect(buildLiveVoiceTokenConfig().systemInstruction).toBeTruthy()
    expect(buildLiveVoiceConfig().tools).toHaveLength(1)
    expect(buildLiveVoiceTokenConfig().tools).toBeUndefined()
  })

  it('keeps business truth behind the head boundary (2026-07-23 contract)', () => {
    const config = buildLiveVoiceConfig()
    const declarations = (config.tools?.[0] as { functionDeclarations?: Array<{ name?: string }> })
      ?.functionDeclarations ?? []
    expect(declarations.map((item) => item.name)).toContain('run_agent_turn')
    // Casual talk answers directly; business/action requests cross run_agent_turn,
    // and business facts must never be fabricated by the transport model.
    expect(LIVE_VOICE_SYSTEM_INSTRUCTION).toContain('run_agent_turn ঠিক একবার চালাবে')
    expect(LIVE_VOICE_SYSTEM_INSTRUCTION).toContain('ব্যবসার তথ্য বা হিসাব কখনো নিজে বানাবে না')
    // Read-only fast lane exists but is scoped to lookups only.
    expect(LIVE_VOICE_SYSTEM_INSTRUCTION).toContain('quick_erp_lookup')
    expect(LIVE_VOICE_SYSTEM_INSTRUCTION).toContain('completed/reportReady')
    expect(LIVE_VOICE_SYSTEM_INSTRUCTION).toContain('লিখিত রিপোর্ট পড়ার মতো একটানা বলবে না')
    expect(LIVE_VOICE_SYSTEM_INSTRUCTION).toContain('বাক্য শেষ করার চেষ্টা না করে')
    expect(LIVE_VOICE_SYSTEM_INSTRUCTION).not.toContain('স্যার')
  })

  it('offers exactly two Gemini Native Audio models and a validated voice catalog', () => {
    expect(DEFAULT_LIVE_VOICE_MODEL).toBe(GEMINI_25_LIVE_MODEL)
    expect(DEFAULT_LIVE_VOICE_NAME).toBe('Aoede')
    expect(LIVE_VOICE_MODEL_IDS).toEqual([GEMINI_25_LIVE_MODEL, GEMINI_31_LIVE_MODEL])
    expect(LIVE_VOICE_NAMES).toEqual(['Aoede', 'Achernar', 'Kore', 'Charon', 'Orus', 'Sulafat'])
    expect(isSupportedLiveVoiceModel(GEMINI_25_LIVE_MODEL)).toBe(true)
    expect(isSupportedLiveVoiceModel('gpt-realtime')).toBe(false)
    expect(isSupportedLiveVoiceName('Sulafat')).toBe(true)
    expect(isSupportedLiveVoiceName('unknown')).toBe(false)
  })

  it('uses model-specific low-latency and affective settings', () => {
    const natural = buildLiveVoiceConfig('Aoede', GEMINI_25_LIVE_MODEL)
    const fast = buildLiveVoiceConfig('Charon', GEMINI_31_LIVE_MODEL)
    const naturalToken = buildLiveVoiceTokenConfig('Aoede', GEMINI_25_LIVE_MODEL)
    expect(natural.enableAffectiveDialog).toBe(true)
    expect(naturalToken.enableAffectiveDialog).toBe(true)
    expect(natural.thinkingConfig?.thinkingBudget).toBe(0)
    expect(fast.enableAffectiveDialog).toBeUndefined()
    expect(fast.thinkingConfig?.thinkingLevel).toBe('MINIMAL')
    expect(natural.speechConfig?.languageCode).toBeUndefined()
  })

  it('avoids robotic conversation habits and asks for Bangladeshi pronunciation', () => {
    expect(buildLiveVoiceConfig().temperature).toBe(0.4)
    expect(LIVE_VOICE_SYSTEM_INSTRUCTION).toContain('প্রশ্নের মতো করে পুনরাবৃত্তি করবে না')
    expect(LIVE_VOICE_SYSTEM_INSTRUCTION).toContain('“আর কিছু জানতে চান?”')
    expect(LIVE_VOICE_SYSTEM_INSTRUCTION).toContain('স্বাভাবিকভাবে থামবে')
    expect(LIVE_VOICE_SYSTEM_INSTRUCTION).toContain('দুঃখ বা খারাপ খবরে')
    expect(LIVE_VOICE_SYSTEM_INSTRUCTION).toContain('চাপ, রাগ বা হতাশায়')
    expect(LIVE_VOICE_SYSTEM_INSTRUCTION).toContain('শ্বাসের শব্দ, দীর্ঘশ্বাস')
    expect(LIVE_VOICE_SYSTEM_INSTRUCTION).toContain('Boss তালিকা চাইলে তবেই numbered list')
    expect(LIVE_VOICE_SYSTEM_INSTRUCTION).toContain('প্রমিত বাংলাদেশি বাংলা')
  })

  it('uses the documented v1beta ephemeral-token transport required for affective dialog', () => {
    const route = readFileSync(join(process.cwd(), 'src/app/api/assistant/live-session/route.ts'), 'utf8')

    expect(route).toContain("apiVersion: 'v1beta'")
    expect(route).toContain('google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained')
    expect(route).toContain('unsupported_live_model')
    expect(route).toContain('unsupported_live_voice')
    expect(route).toContain('buildLiveVoiceTokenConfig(voice, model)')
    expect(route).not.toContain("apiVersion: 'v1alpha'")
  })
})
