import { describe, expect, it } from 'vitest'
import {
  LIVE_VOICE_CONTRACT,
  liveVoiceRemoteModelAvailability,
  liveVoiceRolloutDefaults,
  migrateLiveVoiceSelection,
  parseLiveVoiceContract,
} from '@/agent/lib/live-voice-contract'
import { buildLiveVoiceConfig } from '@/agent/lib/live-voice-config'

describe('versioned live voice contract', () => {
  it('has one enabled default and an explicit bounded compression window', () => {
    const contract = LIVE_VOICE_CONTRACT
    expect(contract.contractVersion).toBe('live-voice-2026-08-11-v1')
    expect(contract.schemaVersion).toBe(1)
    expect(contract.models.filter((model) => model.enabled).map((model) => model.id))
      .toEqual([
        'gemini-2.5-flash-native-audio-preview-12-2025',
        'gemini-3.1-flash-live-preview',
      ])
    expect(contract.voices.filter((voice) => voice.enabled).map((voice) => voice.id))
      .toEqual(['Aoede', 'Achernar', 'Kore', 'Charon', 'Orus', 'Sulafat'])
    expect(contract.defaults).toEqual({
      modelID: 'gemini-2.5-flash-native-audio-preview-12-2025',
      voiceID: 'Aoede',
    })
    expect(contract.contextCompression).toMatchObject({
      triggerTokens: 25_000,
      targetTokens: 8_000,
      sourceURL: 'https://ai.google.dev/gemini-api/docs/live-api/best-practices',
      verifiedAt: '2026-08-11',
    })
    expect(contract.localBudget.audioTokensPerSecond).toBe(25)
    expect(contract.contextCompression.targetTokens)
      .toBeLessThan(contract.contextCompression.triggerTokens)
    expect(buildLiveVoiceConfig().contextWindowCompression).toEqual({
      triggerTokens: '25000',
      slidingWindow: { targetTokens: '8000' },
    })
  })

  it('owns model capabilities instead of inferring them from model names', () => {
    const [natural, fast] = LIVE_VOICE_CONTRACT.models
    expect(natural.capabilities).toMatchObject({
      affectiveDialog: true,
      functionCallingMode: 'synchronous-and-asynchronous',
      thinking: { mode: 'budget', budget: 0 },
    })
    expect(fast.capabilities).toMatchObject({
      affectiveDialog: false,
      functionCallingMode: 'synchronous-only',
      thinking: { mode: 'level', level: 'MINIMAL' },
    })
  })

  it('migrates legacy valid choices and rolls unknown choices back to defaults', () => {
    expect(migrateLiveVoiceSelection({
      selectionVersion: 0,
      modelID: 'gemini-3.1-flash-live-preview',
      voiceID: 'Kore',
    })).toEqual({
      selectionVersion: 1,
      modelID: 'gemini-3.1-flash-live-preview',
      voiceID: 'Kore',
      migrated: true,
    })

    expect(migrateLiveVoiceSelection({
      selectionVersion: 0,
      modelID: 'retired-model',
      voiceID: 'removed-voice',
    })).toEqual({
      selectionVersion: 1,
      modelID: LIVE_VOICE_CONTRACT.defaults.modelID,
      voiceID: LIVE_VOICE_CONTRACT.defaults.voiceID,
      migrated: true,
    })
  })

  it('has an atomic rollout rollback to the legacy transport defaults', () => {
    const legacy = { modelID: 'legacy-model', voiceID: 'LegacyVoice' }
    expect(liveVoiceRolloutDefaults(true, legacy)).toEqual(LIVE_VOICE_CONTRACT.defaults)
    expect(liveVoiceRolloutDefaults(false, legacy)).toEqual(legacy)
  })

  it('enforces a server-controlled exact model kill with a contract replacement', () => {
    const [natural, fast] = LIVE_VOICE_CONTRACT.models
    expect(liveVoiceRemoteModelAvailability(natural.id, undefined))
      .toEqual({ enabled: true, replacementModelID: null })
    expect(liveVoiceRemoteModelAvailability(
      natural.id,
      ` unknown, ${natural.id} `,
    )).toEqual({ enabled: false, replacementModelID: fast.id })
    expect(liveVoiceRemoteModelAvailability(
      natural.id,
      `${natural.id},${fast.id}`,
    )).toEqual({ enabled: false, replacementModelID: null })
  })

  it('rejects unknown fields, unbounded compression, and unsafe budget ordering', () => {
    expect(() => parseLiveVoiceContract({
      ...LIVE_VOICE_CONTRACT,
      unexpected: true,
    })).toThrow()
    expect(() => parseLiveVoiceContract({
      ...LIVE_VOICE_CONTRACT,
      contextCompression: {
        ...LIVE_VOICE_CONTRACT.contextCompression,
        triggerTokens: 8_000,
        targetTokens: 8_000,
      },
    })).toThrow(/targetTokens/)
    expect(() => parseLiveVoiceContract({
      ...LIVE_VOICE_CONTRACT,
      localBudget: {
        ...LIVE_VOICE_CONTRACT.localBudget,
        warningMicroUSD: LIVE_VOICE_CONTRACT.localBudget.terminationMicroUSD,
      },
    })).toThrow(/warning budget/)
  })
})
