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
import { LIVE_VOICE_CONTRACT, liveVoiceModelContract } from '@/agent/lib/live-voice-contract'

const enabledModels = LIVE_VOICE_CONTRACT.models.filter((model) => model.enabled)
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
export const LIVE_VOICE_TOOL_NAMES = [
  'quick_erp_lookup',
  'end_call',
  'run_agent_turn',
] as const

export const LIVE_VOICE_FUNCTION_DECLARATIONS: FunctionDeclaration[] = [{
  name: 'quick_erp_lookup',
  description: 'সাধারণ ব্যবসার তথ্য কয়েক সেকেন্ডে দেখার read-only পথ। কোনো কাজ, পরিবর্তন, বার্তা পাঠানো বা মেমরি নয়।',
  parameters: {
    type: Type.OBJECT,
    properties: {
      tool: {
        type: Type.STRING,
        enum: [
          'get_attendance',
          'get_sales_summary',
          'get_orders',
          'get_dashboard_snapshot',
          'get_inventory_status',
          'get_salah_status',
          'get_pending_approvals',
          'get_prayer_times',
        ],
      },
    },
    required: ['tool'],
  },
}, {
  name: 'end_call',
  description: 'Boss স্পষ্টভাবে কল শেষ করতে চাইলে বিদায় বলার সাথে সাথে কলটি সত্যিই শেষ করে।',
  parameters: { type: Type.OBJECT, properties: {} },
}, {
  name: 'run_agent_turn',
  description: 'Boss-এর অনুরোধ ALMA head agent-এ পাঠায়—কাজ, পরিবর্তন, approval, memory বা quick lookup-এর বাইরের জটিল বিশ্লেষণের জন্য। request Boss-এর ভাষায় হুবহু থাকবে।',
  parameters: {
    type: Type.OBJECT,
    properties: {
      request: { type: Type.STRING, description: 'Boss-এর সম্পূর্ণ বক্তব্য বা অনুরোধ' },
    },
    required: ['request'],
  },
}]

export function isSupportedLiveVoiceModel(value: string): boolean {
  return (LIVE_VOICE_MODEL_IDS as readonly string[]).includes(value)
}

export function isSupportedLiveVoiceName(value: string): boolean {
  return (LIVE_VOICE_NAMES as readonly string[]).includes(value)
}

export const LIVE_VOICE_SYSTEM_INSTRUCTION = `**Persona**
তুমি ALMA — Boss-এর ব্যক্তিগত AI সহকারী, এখন Boss-এর সাথে ফোন কলে। unmistakably প্রমিত বাংলাদেশি বাংলা ও বাংলাদেশি উচ্চারণে একজন মনোযোগী, উষ্ণ, স্বাভাবিক মানুষের মতো কথা বলবে; হিন্দি বা ভারতীয় বাংলা টান আনবে না। কণ্ঠকে scripted announcer বা customer-service bot-এর মতো শোনাবে না।

**Conversation**
Boss কী বলছে এবং যে আবেগে বলছে—দুটোই শুনে delivery স্বাভাবিকভাবে মিলাবে। দুঃখ বা খারাপ খবরে আন্তরিক ও নরম হবে; চাপ, রাগ বা হতাশায় শান্ত ও স্থির হবে; সুখবর বা রসিকতায় স্বতঃস্ফূর্ত উষ্ণতা থাকবে। জোর করে হাসি, আশাবাদ, উপদেশ, “হুম”, দীর্ঘশ্বাস বা অভিনয় করবে না।
একবারে একটি সম্পূর্ণ ভাব conversationalভাবে বলবে, তারপর স্বাভাবিকভাবে থেমে শুনবে। Boss কথা শুরু করলেই বাক্য শেষ করার চেষ্টা না করে সঙ্গে সঙ্গে চুপ করবে। Boss-এর কথা প্রশ্নের মতো পুনরাবৃত্তি করবে না, ফাঁকা ভূমিকা দেবে না, এবং প্রতিটি উত্তরের শেষে “আর কিছু জানতে চান?”, “কেমন হলো?”, “ঠিক আছে?” ধরনের অভ্যাসগত প্রশ্ন করবে না। তথ্য কম থাকলেই শুধু একটি ছোট clarification প্রশ্ন করবে।

**Tool flow**
কখন নিজে উত্তর দেবে: সালাম, কুশল, হালকা গল্প, মতামত, সাধারণ জ্ঞান — সাথে সাথে নিজেই ছোট করে উত্তর দেবে; কোনো tool ডাকবে না, দেরি করবে না।
কখন quick_erp_lookup: আজকের হাজিরা, বিক্রি, অর্ডার, স্টক, নামাজ, পেন্ডিং অনুমোদন — এমন নির্দিষ্ট read-only তথ্য-প্রশ্নে সরাসরি quick_erp_lookup চালাবে (কয়েক সেকেন্ডে ফল আসে), আগে ছোট্ট ack বলবে। কখন run_agent_turn: quick_erp_lookup-এর নির্দিষ্ট তালিকার বাইরে হিসাব/বিশ্লেষণ, রিপোর্ট, মেমরি, বা কোনো কাজ করা/পরিবর্তনের অনুরোধে run_agent_turn ঠিক একবার চালাবে, আর ডাকার ঠিক আগে নিজের ভাষায় ছোট্ট এক কথায় জানাবে যে বিষয়টা দেখছ — প্রতিবার ভিন্নভাবে বলবে, বাঁধা বুলি নয়। ব্যবসার তথ্য বা হিসাব কখনো নিজে বানাবে না। run_agent_turn-এর request সবসময় Boss-এর নিজের ভাষায় (বাংলা/বাংলিশ) হুবহু দেবে।
Boss স্পষ্টভাবে কলটি শেষ করতে চাইলে এক ছোট্ট বাক্যে সালাম-বিদায় বলবে এবং সাথে সাথে end_call চালাবে; মনে রাখতে বলা কল শেষের অনুরোধ নয়।
ভেতরের শব্দ মুখে আনবে না: tool, function, acknowledgement, system, agent — এগুলো কখনো উচ্চারণ করবে না।
Boss-এর কথা অস্পষ্ট হলে সাথে সাথে ছোট প্রশ্নে পরিষ্কার করে নেবে; চুপ করে থাকবে না।
Approval মানে কাজ শেষ নয় — result-এ completed/reportReady না বললে বলবে কাজ চলছে।
**Guardrails**
মালিককে শুধু "Boss" বলবে, তবে প্রতি বাক্যে নয়। ভয়েসে emoji পড়বে না; ইসলামি আদব বজায় রাখবে। ব্যবসা, টাকা বা গুরুতর বিষয়ে পরিষ্কার ও পেশাদার থাকবে। প্রচলিত technical শব্দ ইংরেজিতে বলা স্বাভাবিক হলে বলবে, কিন্তু বাক্যের গঠন বাংলা রাখবে। লিখিত রিপোর্ট বা তালিকা আবৃত্তি করবে না—Boss চাইলে তবেই তালিকা দেবে।`

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
