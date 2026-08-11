import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  decodeLiveVoiceContractStrict,
  LIVE_VOICE_CONTRACT,
  liveVoiceModelContract,
  liveVoiceRemoteModelAvailability,
  liveVoiceRolloutDefaults,
  migrateLiveVoiceSelection,
  parseLiveVoiceContract,
} from '@/agent/lib/live-voice-contract'
import { buildLiveVoiceConfig } from '@/agent/lib/live-voice-config'

describe('versioned live voice contract', () => {
  const source = () => readFileSync(
    join(process.cwd(), 'config/live-voice/live-voice-v1.json'),
    'utf8',
  )

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

  it('keeps decoded canonical session semantics identical to the TypeScript runtime payload', () => {
    const decoded = decodeLiveVoiceContractStrict(source())
    const config = buildLiveVoiceConfig()
    const declarations = (config.tools?.[0] as {
      functionDeclarations?: unknown[]
    }).functionDeclarations

    expect({
      systemInstruction: config.systemInstruction,
      functionDeclarations: declarations,
    }).toEqual(decoded.sessionProtocol)
    expect(decoded.sessionProtocol.functionDeclarations.map((item) => item.name)).toEqual([
      'quick_erp_lookup',
      'end_call',
      'run_agent_turn',
    ])
  })

  it('strictly rejects lexical duplicates and semantic tool-contract drift', () => {
    const duplicate = source().replace(
      '"sessionProtocol": {',
      '"sessionProtocol": { "system\\u0049nstruction": "shadow",',
    )
    expect(() => decodeLiveVoiceContractStrict(duplicate)).toThrow(/duplicate key/)

    const duplicateTool = structuredClone(LIVE_VOICE_CONTRACT)
    duplicateTool.sessionProtocol.functionDeclarations[1]!.name = 'quick_erp_lookup'
    expect(() => parseLiveVoiceContract(duplicateTool)).toThrow(/canonical unique order/)

    const schemaDrift = structuredClone(LIVE_VOICE_CONTRACT)
    schemaDrift.sessionProtocol.functionDeclarations[0]!.parameters.required = ['missing']
    expect(() => parseLiveVoiceContract(schemaDrift)).toThrow(/required field|quick lookup schema/)
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
    expect(liveVoiceRemoteModelAvailability(
      fast.id,
      fast.id,
    )).toEqual({ enabled: false, replacementModelID: null })
    expect(liveVoiceRemoteModelAvailability(
      fast.id,
      natural.id,
    )).toEqual({ enabled: true, replacementModelID: null })
  })

  it('never selects a retired model even when its enabled flag remains true', () => {
    const [natural, fast] = LIVE_VOICE_CONTRACT.models
    const fixture = structuredClone(LIVE_VOICE_CONTRACT)
    fixture.models[1]!.enabled = true
    fixture.models[1]!.lifecycle = 'retired'
    const contract = parseLiveVoiceContract(fixture)

    expect(contract.models[1]).toMatchObject({ id: fast.id, enabled: true, lifecycle: 'retired' })
    expect(liveVoiceModelContract(fast.id, contract)).toBeUndefined()
    expect(liveVoiceRemoteModelAvailability(
      natural.id,
      natural.id,
      contract,
    )).toEqual({ enabled: false, replacementModelID: null })
    expect(migrateLiveVoiceSelection({
      selectionVersion: contract.schemaVersion,
      modelID: fast.id,
      voiceID: contract.defaults.voiceID,
    }, contract).modelID).toBe(contract.defaults.modelID)
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
