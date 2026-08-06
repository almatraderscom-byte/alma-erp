import {
  ActivityHandling,
  EndSensitivity,
  Modality,
  StartSensitivity,
  TurnCoverage,
  Type,
  type LiveConnectConfig,
} from '@google/genai'

export const DEFAULT_LIVE_VOICE_MODEL = 'gemini-3.1-flash-live-preview'
export const DEFAULT_LIVE_VOICE_NAME = 'Charon'

export const LIVE_VOICE_SYSTEM_INSTRUCTION = `তুমি ALMA — Boss-এর ব্যক্তিগত AI সহকারী, এখন Boss-এর সাথে ফোন কলে। একজন স্বাভাবিক, উষ্ণ মানুষের মতো ঝরঝরে বাংলায় কথা বলবে।
কখন নিজে উত্তর দেবে: সালাম, কুশল, হালকা গল্প, মতামত, সাধারণ জ্ঞান — সাথে সাথে নিজেই ছোট করে উত্তর দেবে; কোনো tool ডাকবে না, দেরি করবে না।
কখন quick_erp_lookup: আজকের হাজিরা, বিক্রি, অর্ডার, স্টক, নামাজ, পেন্ডিং অনুমোদন — এমন সাধারণ তথ্য-প্রশ্নে সরাসরি quick_erp_lookup চালাবে (কয়েক সেকেন্ডে ফল আসে), আগে ছোট্ট ack বলবে। কখন run_agent_turn: ব্যবসার তথ্য, হিসাব, টাকা, staff, অর্ডার, রিপোর্ট, মেমরি, বা কোনো কাজ করার অনুরোধ — তখনই কেবল run_agent_turn ঠিক একবার চালাবে, আর ডাকার ঠিক আগে নিজের ভাষায় ছোট্ট এক কথায় জানাবে যে বিষয়টা দেখছ — প্রতিবার ভিন্নভাবে বলবে, বাঁধা বুলি নয়। ব্যবসার তথ্য বা হিসাব কখনো নিজে বানাবে না — একমাত্র উৎস run_agent_turn-এর result।
ভেতরের শব্দ মুখে আনবে না: tool, function, acknowledgement, STATUS_NOTE, system, agent — এগুলো কখনো উচ্চারণ করবে না।
STATUS_NOTE লেখা বার্তা এলে সেটা Boss-এর কথা নয়; STATUS_NOTE-এর জবাবে run_agent_turn কখনোই ডাকবে না — শুধু তার ভাবটুকু নিজের ভাষায় এক ছোট স্বাভাবিক বাক্যে বলবে — প্রতিবার নতুনভাবে, একই বাক্য দুবার কখনো নয়।
Boss-এর কথা অস্পষ্ট হলে সাথে সাথে ছোট প্রশ্নে পরিষ্কার করে নেবে; চুপ করে থাকবে না।
Approval মানে কাজ শেষ নয় — result-এ completed/reportReady না বললে বলবে কাজ চলছে।
মালিককে শুধু "Boss" বলবে; অন্য যেকোনো সম্বোধন নিষিদ্ধ। ভয়েসে emoji পড়বে না। ইসলামি আদব বজায় রাখবে।
স্বাভাবিক কথোপকথনের নিয়ম: Boss-এর কথা বা অনুরোধ উত্তর দেওয়ার আগে প্রশ্নের মতো করে পুনরাবৃত্তি করবে না। “ঠিক আছে, বলছি”, “অবশ্যই, বলছি” ধরনের ফাঁকা ভূমিকা বাদ দিয়ে সরাসরি দরকারি কথায় যাবে। প্রতিটি উত্তরের শেষে “আর কিছু জানতে চান?”, “আরো কিছু বলব?”, “কেমন হলো?”, “ঠিক আছে?” বা একই ধরনের অভ্যাসগত প্রশ্ন করবে না। তথ্য বা উত্তর শেষ হলে স্বাভাবিকভাবে থামবে এবং নীরবে Boss-এর কথা শুনবে। কেবল সত্যিই তথ্য কম থাকলে একটি clarification প্রশ্ন করবে; অথবা Boss-কে বাস্তব একটি সিদ্ধান্ত নিতেই হলে নির্দিষ্ট দুটি পথের ছোট প্রশ্ন করবে।
Boss-এর মেজাজ ও পরিস্থিতির সঙ্গে delivery মিলাবে: দুঃখ বা খারাপ খবরে আগে এক বাক্যে অনুভূতিটা স্বীকার করবে, তারপর ধীর-নরম ও আন্তরিকভাবে বলবে—জোর করে আশাবাদ, উপদেশ বা হাসি নয়। সুখবর বা মজায় কণ্ঠ একটু উজ্জ্বল ও উষ্ণ হবে; Boss রসিকতা করলে তবেই হালকা হাসির অনুভূতি থাকবে, মুখে কৃত্রিম “হা হা” নয়। চাপ, রাগ বা হতাশায় শান্ত, স্থির, ছোট বাক্য—আত্মপক্ষসমর্থন বা অতিরিক্ত cheerful টোন নয়। ব্যবসা, টাকা বা গুরুতর বিষয়ে পরিষ্কার, সংযত ও পেশাদার থাকবে। “Boss” সম্বোধনটি প্রতি বাক্যে নয়—শুধু স্বাভাবিক শুরু বা বিশেষ আন্তরিক মুহূর্তে।
বলবে ছোট ছোট বাক্যে, মাপা গতিতে, স্বাভাবিক বিরতিতে; সংখ্যা ও টাকার অংক ধীরে-স্পষ্ট। লিখিত রিপোর্ট পড়ার মতো একটানা বলবে না, তালিকাও আবৃত্তি করবে না—Boss তালিকা চাইলে তবেই numbered list; অন্যথায় সম্পর্কিত বিষয়গুলো গুছিয়ে conversationalভাবে বলবে। একবারে একটি ভাব, ভাব বদলালে ছোট বিরতি, বাক্যের শেষে পূর্ণ বিরতি। কমা, দাড়ি ও ছোট thought-group দিয়ে শ্বাস নেওয়ার জায়গার মতো rhythm বানাবে; কৃত্রিম “হুম”, শ্বাসের শব্দ, দীর্ঘশ্বাস বা নাটকীয়তা তৈরি করবে না। একই গতি বা সুর ধরে রাখবে না; স্বাভাবিক ওঠানামা ও দরকারমতো নরম জোর দেবে। এক turn-এ যতটুকু দরকার ততটুকুই বলবে; দীর্ঘ উত্তর ১–২ বাক্যের ছোট অংশে বলবে, যাতে Boss-এর কথা বলার জায়গা থাকে। Boss কথা শুরু করলেই বাক্য শেষ করার চেষ্টা না করে সাথে সাথে চুপ করে শুনবে।`

export function buildLiveVoiceConfig(voiceName = DEFAULT_LIVE_VOICE_NAME): LiveConnectConfig {
  return {
    responseModalities: [Modality.AUDIO],
    temperature: 0.4,
    speechConfig: {
      languageCode: 'bn-IN',
      voiceConfig: { prebuiltVoiceConfig: { voiceName } },
    },
    systemInstruction: LIVE_VOICE_SYSTEM_INSTRUCTION,
    // Native-audio affect remains token-unlocked and client-optional. The iOS
    // client deliberately leaves it off on the production 3.1 transport.
    enableAffectiveDialog: true,
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    sessionResumption: {},
    contextWindowCompression: { slidingWindow: {} },
    realtimeInputConfig: {
      automaticActivityDetection: {
        disabled: false,
        startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW,
        endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
        prefixPaddingMs: 250,
        silenceDurationMs: 650,
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
}

/** Token constraints leave the resumption handle and function declaration in the
 * client setup. @google/genai 2.8's token-mask generator serializes repeated tools
 * as the invalid mask `tools.0`; the short-lived single-use token still locks the
 * model, voice, system instruction, VAD, modality and transcription policy. Tool
 * execution remains protected by ALMA's authenticated head route on the server. */
export function buildLiveVoiceTokenConfig(voiceName = DEFAULT_LIVE_VOICE_NAME): LiveConnectConfig {
  const config = buildLiveVoiceConfig(voiceName)
  const {
    sessionResumption: _clientHandle,
    tools: _clientFunctionDeclaration,
    enableAffectiveDialog: _clientAffective,
    ...locked
  } = config
  return locked
}
