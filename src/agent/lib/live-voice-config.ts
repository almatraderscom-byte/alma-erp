import {
  ActivityHandling,
  EndSensitivity,
  Modality,
  StartSensitivity,
  ThinkingLevel,
  TurnCoverage,
  Type,
  type LiveConnectConfig,
} from '@google/genai'

export const GEMINI_25_LIVE_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025'
export const GEMINI_31_LIVE_MODEL = 'gemini-3.1-flash-live-preview'
export const LIVE_VOICE_MODEL_IDS = [GEMINI_25_LIVE_MODEL, GEMINI_31_LIVE_MODEL] as const
export const LIVE_VOICE_NAMES = [
  'Aoede',
  'Achernar',
  'Kore',
  'Charon',
  'Orus',
  'Sulafat',
] as const

export const DEFAULT_LIVE_VOICE_MODEL = GEMINI_25_LIVE_MODEL
export const DEFAULT_LIVE_VOICE_NAME = 'Aoede'

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
কখন quick_erp_lookup: আজকের হাজিরা, বিক্রি, অর্ডার, স্টক, নামাজ, পেন্ডিং অনুমোদন — এমন সাধারণ তথ্য-প্রশ্নে সরাসরি quick_erp_lookup চালাবে (কয়েক সেকেন্ডে ফল আসে), আগে ছোট্ট ack বলবে। কখন run_agent_turn: ব্যবসার তথ্য, হিসাব, টাকা, staff, অর্ডার, রিপোর্ট, মেমরি, বা কোনো কাজ করার অনুরোধ — তখনই কেবল run_agent_turn ঠিক একবার চালাবে, আর ডাকার ঠিক আগে নিজের ভাষায় ছোট্ট এক কথায় জানাবে যে বিষয়টা দেখছ — প্রতিবার ভিন্নভাবে বলবে, বাঁধা বুলি নয়। ব্যবসার তথ্য বা হিসাব কখনো নিজে বানাবে না — একমাত্র উৎস run_agent_turn-এর result।
ভেতরের শব্দ মুখে আনবে না: tool, function, acknowledgement, STATUS_NOTE, system, agent — এগুলো কখনো উচ্চারণ করবে না।
STATUS_NOTE লেখা বার্তা এলে সেটা Boss-এর কথা নয়; STATUS_NOTE-এর জবাবে run_agent_turn কখনোই ডাকবে না — শুধু তার ভাবটুকু নিজের ভাষায় এক ছোট স্বাভাবিক বাক্যে বলবে — প্রতিবার নতুনভাবে, একই বাক্য দুবার কখনো নয়।
Boss-এর কথা অস্পষ্ট হলে সাথে সাথে ছোট প্রশ্নে পরিষ্কার করে নেবে; চুপ করে থাকবে না।
Approval মানে কাজ শেষ নয় — result-এ completed/reportReady না বললে বলবে কাজ চলছে।
**Guardrails**
মালিককে শুধু "Boss" বলবে, তবে প্রতি বাক্যে নয়। ভয়েসে emoji পড়বে না; ইসলামি আদব বজায় রাখবে। ব্যবসা, টাকা বা গুরুতর বিষয়ে পরিষ্কার ও পেশাদার থাকবে। প্রচলিত technical শব্দ ইংরেজিতে বলা স্বাভাবিক হলে বলবে, কিন্তু বাক্যের গঠন বাংলা রাখবে। লিখিত রিপোর্ট বা তালিকা আবৃত্তি করবে না—Boss চাইলে তবেই তালিকা দেবে।`

export function buildLiveVoiceConfig(
  voiceName = DEFAULT_LIVE_VOICE_NAME,
  model = DEFAULT_LIVE_VOICE_MODEL,
): LiveConnectConfig {
  const config: LiveConnectConfig = {
    responseModalities: [Modality.AUDIO],
    temperature: 0.7,
    speechConfig: {
      voiceConfig: { prebuiltVoiceConfig: { voiceName } },
    },
    systemInstruction: LIVE_VOICE_SYSTEM_INSTRUCTION,
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    sessionResumption: {},
    contextWindowCompression: { slidingWindow: {} },
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
    tools: [{
      functionDeclarations: [{
        name: 'run_agent_turn',
        description: 'Boss-এর কথাটি ALMA head agent-এ পাঠায়। ব্যবসার তথ্য, memory, tool use, approval এবং সব owner-facing action এই head agent-ই পরিচালনা করে।',
        parameters: {
          type: Type.OBJECT,
          properties: {
            request: { type: Type.STRING, description: 'Boss-এর সম্পূর্ণ বক্তব্য বা অনুরোধ' },
          },
          required: ['request'],
        },
      }],
    }],
  }

  if (model === GEMINI_25_LIVE_MODEL) {
    config.enableAffectiveDialog = true
    config.thinkingConfig = { thinkingBudget: 0 }
  } else {
    config.thinkingConfig = { thinkingLevel: ThinkingLevel.MINIMAL }
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
