import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildBareClientLiveVoiceTokenConfig,
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
  LIVE_VOICE_TOOL_NAMES,
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
    expect(LIVE_VOICE_SYSTEM_INSTRUCTION).toContain('লিখিত রিপোর্ট বা তালিকা আবৃত্তি করবে না')
    expect(LIVE_VOICE_SYSTEM_INSTRUCTION).toContain('বাক্য শেষ করার চেষ্টা না করে')
    expect(LIVE_VOICE_SYSTEM_INSTRUCTION).not.toContain('স্যার')
  })

  it('advertises the same synchronous exact tool contract for both live models', () => {
    for (const model of LIVE_VOICE_MODEL_IDS) {
      const config = buildLiveVoiceConfig('Aoede', model)
      const declarations = (config.tools?.[0] as {
        functionDeclarations?: Array<{
          name?: string
          behavior?: string
          parameters?: { required?: string[] }
        }>
      })?.functionDeclarations ?? []

      expect(declarations.map((item) => item.name)).toEqual(LIVE_VOICE_TOOL_NAMES)
      expect(declarations.find((item) => item.name === 'quick_erp_lookup')?.parameters?.required)
        .toEqual(['tool'])
      expect(declarations.find((item) => item.name === 'run_agent_turn')?.parameters?.required)
        .toEqual(['request'])
      expect(declarations.every((item) => item.behavior === undefined)).toBe(true)
      expect(JSON.stringify(config.tools)).not.toContain('NON_BLOCKING')
    }
    expect(LIVE_VOICE_SYSTEM_INSTRUCTION).not.toContain('STATUS_NOTE')
  })

  it('offers exactly two Gemini Native Audio models and a validated voice catalog', () => {
    // July bake-off verdict, reaffirmed by the 2026-08-13 outage: 3.1/Charon
    // is the proven default; 2.5 stays selectable in the voice section.
    expect(DEFAULT_LIVE_VOICE_MODEL).toBe(GEMINI_31_LIVE_MODEL)
    expect(DEFAULT_LIVE_VOICE_NAME).toBe('Charon')
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
    // Affective dialog is dead on the ephemeral-token transport (the token
    // proto lacks the field; the client sending it kills the session) — the
    // contract must never re-enable it for token-minted sessions.
    expect(natural.enableAffectiveDialog).toBeUndefined()
    expect(naturalToken.enableAffectiveDialog).toBeUndefined()
    expect(natural.thinkingConfig?.thinkingBudget).toBe(0)
    expect(fast.enableAffectiveDialog).toBeUndefined()
    expect(fast.thinkingConfig?.thinkingLevel).toBe('MINIMAL')
    expect(natural.speechConfig?.languageCode).toBeUndefined()
  })

  it('sends proactive audio only when the contract declares it', () => {
    // Proactive audio lets the model decide input is "not directed at me" and
    // stay silent. On the no-AEC simulator with a noisy Mac microphone that
    // read as ignoring the owner until he repeated himself 4-6 times
    // (2026-08-13), so the contract ships it OFF until a real-device
    // evaluation proves it helps. The plumbing stays: flipping the contract
    // flag re-enables it without a code change.
    expect(buildLiveVoiceConfig('Aoede', GEMINI_25_LIVE_MODEL).proactivity)
      .toBeUndefined()
    expect(buildLiveVoiceTokenConfig('Aoede', GEMINI_25_LIVE_MODEL).proactivity)
      .toBeUndefined()
    expect(buildLiveVoiceConfig('Charon', GEMINI_31_LIVE_MODEL).proactivity)
      .toBeUndefined()
  })

  it('lets ALMA open a turn like a person instead of banning every filler', () => {
    // The old instruction banned "হুম" outright, which is why the owner heard a
    // machine. Naturalness is bounded, not forbidden: one opener per turn, and
    // never spoken over the owner — the provider is strictly turn-based.
    expect(LIVE_VOICE_SYSTEM_INSTRUCTION).toContain('“হুম”')
    expect(LIVE_VOICE_SYSTEM_INSTRUCTION).not.toContain('জোর করে হাসি, আশাবাদ, উপদেশ, “হুম”')
    expect(LIVE_VOICE_SYSTEM_INSTRUCTION).toContain('প্রতি টার্নে সর্বোচ্চ একটি')
    expect(LIVE_VOICE_SYSTEM_INSTRUCTION).toContain('Boss কথা বলার সময় নয়')
    // Theatrics stay banned.
    expect(LIVE_VOICE_SYSTEM_INSTRUCTION).toContain('দীর্ঘশ্বাস')
  })

  it('avoids robotic conversation habits and asks for Bangladeshi pronunciation', () => {
    expect(buildLiveVoiceConfig().temperature).toBe(0.7)
    expect(LIVE_VOICE_SYSTEM_INSTRUCTION.indexOf('**Persona**')).toBeLessThan(
      LIVE_VOICE_SYSTEM_INSTRUCTION.indexOf('**Conversation**'),
    )
    expect(LIVE_VOICE_SYSTEM_INSTRUCTION.indexOf('**Conversation**')).toBeLessThan(
      LIVE_VOICE_SYSTEM_INSTRUCTION.indexOf('**Tool flow**'),
    )
    expect(LIVE_VOICE_SYSTEM_INSTRUCTION.indexOf('**Tool flow**')).toBeLessThan(
      LIVE_VOICE_SYSTEM_INSTRUCTION.indexOf('**Guardrails**'),
    )
    expect(LIVE_VOICE_SYSTEM_INSTRUCTION).toContain('Boss-এর কথা প্রশ্নের মতো পুনরাবৃত্তি করবে না')
    expect(LIVE_VOICE_SYSTEM_INSTRUCTION).toContain('“আর কিছু জানতে চান?”')
    expect(LIVE_VOICE_SYSTEM_INSTRUCTION).toContain('স্বাভাবিকভাবে থেমে শুনবে')
    expect(LIVE_VOICE_SYSTEM_INSTRUCTION).toContain('দুঃখ বা খারাপ খবরে')
    expect(LIVE_VOICE_SYSTEM_INSTRUCTION).toContain('চাপ, রাগ বা হতাশায়')
    expect(LIVE_VOICE_SYSTEM_INSTRUCTION).toContain('scripted announcer')
    expect(LIVE_VOICE_SYSTEM_INSTRUCTION).toContain('জোর করে হাসি')
    expect(LIVE_VOICE_SYSTEM_INSTRUCTION).toContain('Boss চাইলে তবেই তালিকা')
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

  it('freezes the bare-client token to the literals installed binaries ship', () => {
    const bare25 = buildBareClientLiveVoiceTokenConfig('Aoede', GEMINI_25_LIVE_MODEL)
    const bare31 = buildBareClientLiveVoiceTokenConfig('Charon', GEMINI_31_LIVE_MODEL)

    // The generations disagree only on these two fields — each sends its
    // signed bundle's version, so the token must not lock them.
    expect(bare25.systemInstruction).toBeUndefined()
    expect(bare25.contextWindowCompression).toBeUndefined()

    // Every locked value is a literal snapshot of what installed bare-minting
    // binaries send (2026-08-13) — deliberately NOT derived from the contract,
    // so a future contract edit cannot re-break installed builds.
    expect(bare25.responseModalities).toEqual(['AUDIO'])
    expect(bare25.temperature).toBe(0.7)
    expect(bare25.speechConfig).toEqual({
      voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } },
    })
    expect(bare25.inputAudioTranscription).toEqual({})
    expect(bare25.outputAudioTranscription).toEqual({})
    expect(bare25.realtimeInputConfig).toEqual({
      automaticActivityDetection: {
        disabled: false,
        startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
        endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
        prefixPaddingMs: 250,
        silenceDurationMs: 1200,
      },
      activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
      turnCoverage: 'TURN_INCLUDES_ONLY_ACTIVITY',
    })
    // Affective is not locked for bare clients: the mint response answers
    // affectiveDialog=false, so no generation sends the field (Codex P1 #746).
    expect(bare25.enableAffectiveDialog).toBeUndefined()
    expect(bare25.thinkingConfig).toEqual({ thinkingBudget: 0 })
    expect(bare31.enableAffectiveDialog).toBeUndefined()
    expect(bare31.thinkingConfig).toEqual({ thinkingLevel: 'MINIMAL' })
    expect(bare25.proactivity).toBeUndefined()
    expect(bare25.tools).toBeUndefined()
    expect(bare25.sessionResumption).toBeUndefined()
  })

  it('mints bare-client constraints for requests without contractVersion', () => {
    const route = readFileSync(join(process.cwd(), 'src/app/api/assistant/live-session/route.ts'), 'utf8')

    expect(route).toContain('buildBareClientLiveVoiceTokenConfig(voice, model)')
    expect(route).toContain("typeof requested.contractVersion === 'string'")
    expect(route).toContain('=== LIVE_VOICE_CONTRACT.contractVersion')
  })
})
