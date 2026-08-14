import {
  ActivityHandling,
  EndSensitivity,
  Modality,
  StartSensitivity,
  ThinkingLevel,
  TurnCoverage,
  Type,
  type FunctionDeclaration,
  type LiveConnectConfig,
} from '@google/genai'
import {
  isSelectableLiveVoiceModel,
  LIVE_VOICE_CONTRACT,
  liveVoiceModelContract,
} from '@/agent/lib/live-voice-contract'

const enabledModels = LIVE_VOICE_CONTRACT.models.filter(isSelectableLiveVoiceModel)
// Resolved by id, not by capability: affectiveDialog is now false on BOTH
// models (July bake-off + the 2026-08-13 outage both proved 2.5 affective is
// unusable over the ephemeral-token transport), so a capability-based find
// would crash at import.
function contractModelID(id: string): string {
  const model = enabledModels.find((candidate) => candidate.id === id)
  if (!model) throw new Error(`live-voice contract is missing model ${id}`)
  return model.id
}
export const GEMINI_25_LIVE_MODEL = contractModelID(
  'gemini-2.5-flash-native-audio-preview-12-2025',
)
export const GEMINI_31_LIVE_MODEL = contractModelID('gemini-3.1-flash-live-preview')
export const LIVE_VOICE_MODEL_IDS = enabledModels.map((model) => model.id)
export const LIVE_VOICE_NAMES = LIVE_VOICE_CONTRACT.voices
  .filter((voice) => voice.enabled)
  .map((voice) => voice.id)

export const DEFAULT_LIVE_VOICE_MODEL = LIVE_VOICE_CONTRACT.defaults.modelID
export const DEFAULT_LIVE_VOICE_NAME = LIVE_VOICE_CONTRACT.defaults.voiceID
export const LIVE_VOICE_TOOL_NAMES = LIVE_VOICE_CONTRACT.sessionProtocol
  .functionDeclarations.map((declaration) => declaration.name)

export const LIVE_VOICE_FUNCTION_DECLARATIONS: FunctionDeclaration[] =
  LIVE_VOICE_CONTRACT.sessionProtocol.functionDeclarations.map((declaration) => ({
    name: declaration.name,
    description: declaration.description,
    parameters: {
      type: Type.OBJECT,
      properties: Object.fromEntries(
        Object.entries(declaration.parameters.properties).map(([name, parameter]) => [
          name,
          {
            type: Type.STRING,
            ...(parameter.description ? { description: parameter.description } : {}),
            ...(parameter.enum ? { enum: [...parameter.enum] } : {}),
          },
        ]),
      ),
      ...(declaration.parameters.required
        ? { required: [...declaration.parameters.required] }
        : {}),
    },
  }))

export function isSupportedLiveVoiceModel(value: string): boolean {
  return (LIVE_VOICE_MODEL_IDS as readonly string[]).includes(value)
}

export function isSupportedLiveVoiceName(value: string): boolean {
  return (LIVE_VOICE_NAMES as readonly string[]).includes(value)
}

export const LIVE_VOICE_SYSTEM_INSTRUCTION =
  LIVE_VOICE_CONTRACT.sessionProtocol.systemInstruction

export function buildLiveVoiceConfig(
  voiceName = DEFAULT_LIVE_VOICE_NAME,
  model = DEFAULT_LIVE_VOICE_MODEL,
): LiveConnectConfig {
  const modelContract = liveVoiceModelContract(model)
  if (!modelContract) throw new Error('unsupported_live_model')
  const config: LiveConnectConfig = {
    responseModalities: [Modality.AUDIO],
    temperature: 0.7,
    speechConfig: {
      voiceConfig: { prebuiltVoiceConfig: { voiceName } },
    },
    systemInstruction: LIVE_VOICE_SYSTEM_INSTRUCTION,
    inputAudioTranscription: modelContract.capabilities.inputAudioTranscription ? {} : undefined,
    outputAudioTranscription: modelContract.capabilities.outputAudioTranscription ? {} : undefined,
    sessionResumption: {},
    contextWindowCompression: {
      triggerTokens: String(LIVE_VOICE_CONTRACT.contextCompression.triggerTokens),
      slidingWindow: {
        targetTokens: String(LIVE_VOICE_CONTRACT.contextCompression.targetTokens),
      },
    },
    realtimeInputConfig: {
      automaticActivityDetection: {
        disabled: false,
        startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW,
        // Bengali long-form speech naturally contains short thinking/breathing
        // pauses. LOW + 1.2s keeps one thought together without making a normal
        // short reply feel sluggish.
        endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
        prefixPaddingMs: 250,
        silenceDurationMs: 1200,
      },
      activityHandling: ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
      turnCoverage: TurnCoverage.TURN_INCLUDES_ONLY_ACTIVITY,
    },
    tools: [{ functionDeclarations: LIVE_VOICE_FUNCTION_DECLARATIONS }],
  }

  if (modelContract.capabilities.affectiveDialog) {
    config.enableAffectiveDialog = true
  }
  // Proactive audio is what stops a thinking pause ("উম্ম…", "আহ্…") from being
  // read as a finished turn, and it answers sooner once the owner really has
  // finished. Google documents it on the 2.5 native-audio model only, so the
  // contract — not this file — decides which model gets it.
  if (modelContract.capabilities.proactiveAudio) {
    config.proactivity = { proactiveAudio: true }
  }
  if (modelContract.capabilities.thinking.mode === 'budget') {
    config.thinkingConfig = { thinkingBudget: modelContract.capabilities.thinking.budget }
  } else {
    config.thinkingConfig = {
      thinkingLevel: modelContract.capabilities.thinking.level as ThinkingLevel,
    }
  }
  return config
}

/** Token constraints leave the resumption handle and function declaration in the
 * client setup. @google/genai 2.8's token-mask generator serializes repeated tools
 * as the invalid mask `tools.0`; the short-lived single-use token still locks the
 * model, voice, affective mode, system instruction, VAD, modality and transcription
 * policy. Tool execution remains protected by ALMA's authenticated head route. */
export function buildLiveVoiceTokenConfig(
  voiceName = DEFAULT_LIVE_VOICE_NAME,
  model = DEFAULT_LIVE_VOICE_MODEL,
): LiveConnectConfig {
  const config = buildLiveVoiceConfig(voiceName, model)
  const {
    sessionResumption: _clientHandle,
    tools: _clientFunctionDeclaration,
    ...locked
  } = config
  return locked
}

// ————————————————————————————————————————————————————————————————————————————
// Bare-client compatibility. A constrained ephemeral token REJECTS a client
// setup whose value for a locked field differs from the token's. Two client
// generations mint tokens with a bare {model, voice} body: installed
// pre-contract builds (their only mint path) and the contract-era build's
// non-prewarm start and reconnect paths, which also omit contractVersion
// (Codex P1 #1 on PR #744). This constraint set is FROZEN AS LITERALS — the
// field values every installed bare-minting binary ships as of 2026-08-13 —
// and must never be derived from the mutable contract, or a future contract
// edit to a locked field would re-break every installed binary (Codex P1 #2
// on PR #745): the server would lock the new value while the binary keeps
// sending its bundled one, and the setup is rejected into the silent-call
// outage this block exists to prevent. Shipping the contract-v2 lock to bare
// clients is exactly what killed every installed build's live call on
// 2026-08-13 (greeting from the app's local latency path, then the session
// never opened). The system-instruction text and compression thresholds are
// the two fields the generations disagree on — they stay unlocked and come
// from each client's signed bundle. Tool execution stays behind ALMA's
// authenticated head route. Contract evolution belongs to contractVersion
// requests, which keep the full v2 lock; grow this file's frozen sets only
// per-version, never in place.
// ————————————————————————————————————————————————————————————————————————————

const FROZEN_BARE_CLIENT_GEMINI_25 = 'gemini-2.5-flash-native-audio-preview-12-2025'

export function buildBareClientLiveVoiceTokenConfig(
  voiceName = DEFAULT_LIVE_VOICE_NAME,
  model = DEFAULT_LIVE_VOICE_MODEL,
): LiveConnectConfig {
  const locked: LiveConnectConfig = {
    responseModalities: [Modality.AUDIO],
    temperature: 0.7,
    speechConfig: {
      voiceConfig: { prebuiltVoiceConfig: { voiceName } },
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    realtimeInputConfig: {
      automaticActivityDetection: {
        disabled: false,
        startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW,
        endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
        prefixPaddingMs: 250,
        silenceDurationMs: 1200,
      },
      activityHandling: ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
      turnCoverage: TurnCoverage.TURN_INCLUDES_ONLY_ACTIVITY,
    },
  }
  if (model === FROZEN_BARE_CLIENT_GEMINI_25) {
    locked.enableAffectiveDialog = true
    locked.thinkingConfig = { thinkingBudget: 0 }
  } else {
    locked.thinkingConfig = { thinkingLevel: ThinkingLevel.MINIMAL }
  }
  return locked
}
