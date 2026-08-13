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
export const GEMINI_25_LIVE_MODEL = enabledModels.find(
  (model) => model.capabilities.affectiveDialog,
)!.id
export const GEMINI_31_LIVE_MODEL = enabledModels.find(
  (model) => !model.capabilities.affectiveDialog,
)!.id
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
