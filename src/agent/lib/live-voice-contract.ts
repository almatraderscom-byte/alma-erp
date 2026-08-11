import { z } from 'zod'
import rawContract from '../../../config/live-voice/live-voice-v1.json'

const thinkingSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('budget'),
    budget: z.number().int().min(0),
  }).strict(),
  z.object({
    mode: z.literal('level'),
    level: z.enum(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH']),
  }).strict(),
])

const pricingSchema = z.object({
  inputText: z.number().nonnegative(),
  inputAudio: z.number().nonnegative(),
  outputText: z.number().nonnegative(),
  outputAudio: z.number().nonnegative(),
}).strict()

const modelSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
  lifecycle: z.enum(['preview', 'stable', 'retired']),
  replacementModelID: z.string().min(1).nullable(),
  capabilities: z.object({
    affectiveDialog: z.boolean(),
    functionCallingMode: z.enum([
      'synchronous-only',
      'synchronous-and-asynchronous',
    ]),
    thinking: thinkingSchema,
    inputAudioTranscription: z.boolean(),
    outputAudioTranscription: z.boolean(),
  }).strict(),
  pricingUSDPerMillionTokens: pricingSchema,
  display: z.object({
    title: z.string().min(1),
    detail: z.string().min(1),
    badge: z.string().min(1),
    strengths: z.string().min(1),
    limitations: z.string().min(1),
    costLifecycle: z.string().min(1),
    bestUse: z.string().min(1),
  }).strict(),
}).strict()

const voiceSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
  display: z.object({
    name: z.string().min(1),
    detail: z.string().min(1),
    symbol: z.string().min(1),
  }).strict(),
}).strict()

const migrationSchema = z.object({
  fromSelectionVersion: z.number().int().min(0),
  toSelectionVersion: z.number().int().positive(),
  modelReplacements: z.record(z.string(), z.string().min(1)),
  voiceReplacements: z.record(z.string(), z.string().min(1)),
}).strict()

const contractSchema = z.object({
  schemaVersion: z.number().int().positive(),
  contractVersion: z.string().regex(/^live-voice-\d{4}-\d{2}-\d{2}-v\d+$/),
  defaults: z.object({
    modelID: z.string().min(1),
    voiceID: z.string().min(1),
  }).strict(),
  contextCompression: z.object({
    triggerTokens: z.number().int().positive(),
    targetTokens: z.number().int().positive(),
    sourceURL: z.literal('https://ai.google.dev/gemini-api/docs/live-api/best-practices'),
    verifiedAt: z.string().date(),
  }).strict(),
  localBudget: z.object({
    warningMicroUSD: z.number().int().positive(),
    terminationMicroUSD: z.number().int().positive(),
    pollIntervalMilliseconds: z.number().int().min(100).max(5_000),
    audioTokensPerSecond: z.number().positive(),
  }).strict(),
  models: z.array(modelSchema).min(1),
  voices: z.array(voiceSchema).min(1),
  migrations: z.array(migrationSchema),
}).strict().superRefine((contract, context) => {
  if (contract.contextCompression.targetTokens >= contract.contextCompression.triggerTokens) {
    context.addIssue({
      code: 'custom',
      path: ['contextCompression', 'targetTokens'],
      message: 'targetTokens must be lower than triggerTokens',
    })
  }
  if (contract.localBudget.warningMicroUSD >= contract.localBudget.terminationMicroUSD) {
    context.addIssue({
      code: 'custom',
      path: ['localBudget', 'warningMicroUSD'],
      message: 'warning budget must be lower than termination budget',
    })
  }

  const modelIDs = new Set(contract.models.map((model) => model.id))
  const voiceIDs = new Set(contract.voices.map((voice) => voice.id))
  if (modelIDs.size !== contract.models.length) {
    context.addIssue({ code: 'custom', path: ['models'], message: 'model IDs must be unique' })
  }
  if (voiceIDs.size !== contract.voices.length) {
    context.addIssue({ code: 'custom', path: ['voices'], message: 'voice IDs must be unique' })
  }
  if (!contract.models.some((model) => (
    model.id === contract.defaults.modelID && model.enabled
  ))) {
    context.addIssue({
      code: 'custom',
      path: ['defaults', 'modelID'],
      message: 'default model must be enabled',
    })
  }
  if (!contract.voices.some((voice) => (
    voice.id === contract.defaults.voiceID && voice.enabled
  ))) {
    context.addIssue({
      code: 'custom',
      path: ['defaults', 'voiceID'],
      message: 'default voice must be enabled',
    })
  }
  for (const [index, model] of contract.models.entries()) {
    if (model.replacementModelID !== null && !modelIDs.has(model.replacementModelID)) {
      context.addIssue({
        code: 'custom',
        path: ['models', index, 'replacementModelID'],
        message: 'replacement model must exist in this contract',
      })
    }
  }
  if (contract.schemaVersion > 0 && !contract.migrations.some((migration) => (
    migration.fromSelectionVersion === 0
      && migration.toSelectionVersion === contract.schemaVersion
  ))) {
    context.addIssue({
      code: 'custom',
      path: ['migrations'],
      message: 'a bounded v0 migration must be declared',
    })
  }
})

export type LiveVoiceContract = z.infer<typeof contractSchema>
export type LiveVoiceModelContract = LiveVoiceContract['models'][number]

export function parseLiveVoiceContract(value: unknown): LiveVoiceContract {
  return contractSchema.parse(value)
}

export const LIVE_VOICE_CONTRACT = parseLiveVoiceContract(rawContract)

export function liveVoiceRolloutDefaults(
  featureEnabled: boolean,
  legacy: { modelID: string; voiceID: string },
  contract: LiveVoiceContract = LIVE_VOICE_CONTRACT,
): { modelID: string; voiceID: string } {
  return featureEnabled ? contract.defaults : legacy
}

export function liveVoiceModelContract(
  modelID: string,
  contract: LiveVoiceContract = LIVE_VOICE_CONTRACT,
): LiveVoiceModelContract | undefined {
  return contract.models.find((model) => model.id === modelID && model.enabled)
}

export type LiveVoiceRemoteModelAvailability = {
  enabled: boolean
  replacementModelID: string | null
}

/** Server-owned emergency model kill switch. The environment value is a
 * comma-separated list of exact contract model IDs; replacement remains
 * constrained to an enabled model declared by this same versioned contract. */
export function liveVoiceRemoteModelAvailability(
  modelID: string,
  remotelyDisabledModelIDs: string | undefined,
  contract: LiveVoiceContract = LIVE_VOICE_CONTRACT,
): LiveVoiceRemoteModelAvailability {
  const model = contract.models.find((candidate) => candidate.id === modelID)
  const remotelyDisabled = new Set(
    (remotelyDisabledModelIDs ?? '').split(',').map((value) => value.trim()).filter(Boolean),
  )
  const enabled = Boolean(model?.enabled) && !remotelyDisabled.has(modelID)
  if (enabled) return { enabled: true, replacementModelID: null }

  const replacement = model?.replacementModelID
    ? contract.models.find((candidate) => (
      candidate.id === model.replacementModelID
        && candidate.enabled
        && !remotelyDisabled.has(candidate.id)
    ))
    : undefined
  return { enabled: false, replacementModelID: replacement?.id ?? null }
}

export type LiveVoiceStoredSelection = {
  selectionVersion?: number | null
  modelID?: string | null
  voiceID?: string | null
}

export type LiveVoiceMigratedSelection = {
  selectionVersion: number
  modelID: string
  voiceID: string
  migrated: boolean
}

/** Migrates only through declared, monotonically increasing steps. Any broken
 * chain or disabled/unknown choice rolls back to this contract's safe default. */
export function migrateLiveVoiceSelection(
  stored: LiveVoiceStoredSelection,
  contract: LiveVoiceContract = LIVE_VOICE_CONTRACT,
): LiveVoiceMigratedSelection {
  const originalVersion = Number.isInteger(stored.selectionVersion)
    ? Math.max(0, Number(stored.selectionVersion))
    : 0
  let version = originalVersion
  let modelID = stored.modelID?.trim() ?? ''
  let voiceID = stored.voiceID?.trim() ?? ''
  let steps = 0

  while (version < contract.schemaVersion && steps <= contract.migrations.length) {
    const migration = contract.migrations.find((candidate) => (
      candidate.fromSelectionVersion === version
        && candidate.toSelectionVersion > version
        && candidate.toSelectionVersion <= contract.schemaVersion
    ))
    if (!migration) break
    modelID = migration.modelReplacements[modelID] ?? modelID
    voiceID = migration.voiceReplacements[voiceID] ?? voiceID
    version = migration.toSelectionVersion
    steps += 1
  }

  const selectedModel = contract.models.find((model) => model.id === modelID)
  if (!selectedModel?.enabled) {
    const replacement = selectedModel?.replacementModelID
      ? liveVoiceModelContract(selectedModel.replacementModelID, contract)
      : undefined
    modelID = replacement?.id ?? contract.defaults.modelID
  }
  if (!contract.voices.some((voice) => voice.id === voiceID && voice.enabled)) {
    voiceID = contract.defaults.voiceID
  }
  version = contract.schemaVersion

  return {
    selectionVersion: version,
    modelID,
    voiceID,
    migrated: originalVersion !== version
      || stored.modelID !== modelID
      || stored.voiceID !== voiceID,
  }
}
