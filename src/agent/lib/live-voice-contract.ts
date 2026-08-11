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

const toolStringParameterSchema = z.object({
  type: z.literal('STRING'),
  description: z.string().min(1).optional(),
  enum: z.array(z.string().min(1)).min(1).optional(),
}).strict().superRefine((parameter, context) => {
  if (parameter.enum && new Set(parameter.enum).size !== parameter.enum.length) {
    context.addIssue({ code: 'custom', path: ['enum'], message: 'enum values must be unique' })
  }
})

const toolObjectParameterSchema = z.object({
  type: z.literal('OBJECT'),
  properties: z.record(z.string().min(1), toolStringParameterSchema),
  required: z.array(z.string().min(1)).optional(),
}).strict().superRefine((parameter, context) => {
  const required = parameter.required ?? []
  if (new Set(required).size !== required.length) {
    context.addIssue({ code: 'custom', path: ['required'], message: 'required fields must be unique' })
  }
  for (const name of required) {
    if (!(name in parameter.properties)) {
      context.addIssue({
        code: 'custom',
        path: ['required'],
        message: `required field is not declared: ${name}`,
      })
    }
  }
})

const functionDeclarationSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  parameters: toolObjectParameterSchema,
}).strict()

const quickLookupTools = [
  'get_attendance',
  'get_sales_summary',
  'get_orders',
  'get_dashboard_snapshot',
  'get_inventory_status',
  'get_salah_status',
  'get_pending_approvals',
  'get_prayer_times',
] as const

const sessionProtocolSchema = z.object({
  systemInstruction: z.string().min(1),
  functionDeclarations: z.array(functionDeclarationSchema).length(3),
}).strict().superRefine((protocol, context) => {
  const names = protocol.functionDeclarations.map((declaration) => declaration.name)
  const expectedNames = ['quick_erp_lookup', 'end_call', 'run_agent_turn']
  if (new Set(names).size !== names.length || names.some((name, index) => name !== expectedNames[index])) {
    context.addIssue({
      code: 'custom',
      path: ['functionDeclarations'],
      message: 'function declarations must use the canonical unique order',
    })
  }
  if (protocol.systemInstruction.includes('STATUS_NOTE')
    || protocol.systemInstruction.includes('NON_BLOCKING')) {
    context.addIssue({
      code: 'custom',
      path: ['systemInstruction'],
      message: 'unsupported provider control token',
    })
  }

  const [lookup, endCall, agentTurn] = protocol.functionDeclarations
  const lookupProperty = lookup?.parameters.properties.tool
  if (lookup?.parameters.type !== 'OBJECT'
    || Object.keys(lookup.parameters.properties).join(',') !== 'tool'
    || lookup.parameters.required?.join(',') !== 'tool'
    || lookupProperty?.type !== 'STRING'
    || lookupProperty.enum?.join(',') !== quickLookupTools.join(',')) {
    context.addIssue({ code: 'custom', path: ['functionDeclarations', 0], message: 'quick lookup schema drift' })
  }
  if (endCall?.parameters.type !== 'OBJECT'
    || Object.keys(endCall.parameters.properties).length !== 0
    || endCall.parameters.required !== undefined) {
    context.addIssue({ code: 'custom', path: ['functionDeclarations', 1], message: 'end call schema drift' })
  }
  const requestProperty = agentTurn?.parameters.properties.request
  if (agentTurn?.parameters.type !== 'OBJECT'
    || Object.keys(agentTurn.parameters.properties).join(',') !== 'request'
    || agentTurn.parameters.required?.join(',') !== 'request'
    || requestProperty?.type !== 'STRING'
    || requestProperty.enum !== undefined) {
    context.addIssue({ code: 'custom', path: ['functionDeclarations', 2], message: 'agent turn schema drift' })
  }
})

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
  sessionProtocol: sessionProtocolSchema,
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

/** JSON.parse silently keeps one value for duplicate object keys. Canonical
 * contracts are security-sensitive executable configuration, so scan the raw
 * token stream before parsing and reject escaped-equivalent duplicates too. */
export function decodeLiveVoiceContractStrict(source: string): LiveVoiceContract {
  assertNoDuplicateJSONKeys(source)
  return parseLiveVoiceContract(JSON.parse(source) as unknown)
}

function assertNoDuplicateJSONKeys(source: string): void {
  let index = 0
  const whitespace = /\s/u

  function fail(message: string): never {
    throw new Error(`invalid live voice contract JSON: ${message}`)
  }

  function skipWhitespace(): void {
    while (index < source.length && whitespace.test(source[index]!)) index += 1
  }

  function consume(expected: string): void {
    if (source[index] !== expected) fail(`expected ${expected}`)
    index += 1
  }

  function parseString(): string {
    const start = index
    consume('"')
    while (index < source.length) {
      const character = source[index]!
      if (character === '"') {
        index += 1
        return JSON.parse(source.slice(start, index)) as string
      }
      if (character === '\\') {
        index += 1
        const escaped = source[index]
        if (escaped === undefined) fail('unterminated escape')
        if (escaped === 'u') {
          const scalar = source.slice(index + 1, index + 5)
          if (!/^[0-9a-fA-F]{4}$/u.test(scalar)) fail('invalid unicode escape')
          index += 5
        } else {
          if (!['"', '\\', '/', 'b', 'f', 'n', 'r', 't'].includes(escaped)) {
            fail('invalid string escape')
          }
          index += 1
        }
      } else {
        if (character.charCodeAt(0) < 0x20) fail('control character in string')
        index += 1
      }
    }
    return fail('unterminated string')
  }

  function parseObject(): void {
    consume('{')
    skipWhitespace()
    if (source[index] === '}') {
      index += 1
      return
    }
    const keys = new Set<string>()
    while (true) {
      skipWhitespace()
      if (source[index] !== '"') fail('object key expected')
      const key = parseString()
      if (keys.has(key)) fail(`duplicate key: ${key}`)
      keys.add(key)
      skipWhitespace()
      consume(':')
      parseValue()
      skipWhitespace()
      if (source[index] === '}') {
        index += 1
        return
      }
      consume(',')
    }
  }

  function parseArray(): void {
    consume('[')
    skipWhitespace()
    if (source[index] === ']') {
      index += 1
      return
    }
    while (true) {
      parseValue()
      skipWhitespace()
      if (source[index] === ']') {
        index += 1
        return
      }
      consume(',')
    }
  }

  function parseLiteral(literal: string): void {
    if (source.slice(index, index + literal.length) !== literal) fail(`expected ${literal}`)
    index += literal.length
  }

  function parseNumber(): void {
    const start = index
    while (index < source.length && !/[\s,\]}]/u.test(source[index]!)) index += 1
    const token = source.slice(start, index)
    if (token.length === 0 || typeof JSON.parse(token) !== 'number') fail('invalid number')
  }

  function parseValue(): void {
    skipWhitespace()
    switch (source[index]) {
      case '{': parseObject(); return
      case '[': parseArray(); return
      case '"': parseString(); return
      case 't': parseLiteral('true'); return
      case 'f': parseLiteral('false'); return
      case 'n': parseLiteral('null'); return
      default: parseNumber()
    }
  }

  parseValue()
  skipWhitespace()
  if (index !== source.length) fail('trailing bytes')
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
