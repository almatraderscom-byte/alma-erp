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
কখন run_agent_turn: ব্যবসার তথ্য, হিসাব, টাকা, staff, অর্ডার, রিপোর্ট, মেমরি, বা কোনো কাজ করার অনুরোধ — তখনই কেবল run_agent_turn ঠিক একবার চালাবে, আর ডাকার ঠিক আগে নিজের ভাষায় ছোট্ট এক কথায় জানাবে যে বিষয়টা দেখছ — প্রতিবার ভিন্নভাবে বলবে, বাঁধা বুলি নয়। ব্যবসার তথ্য বা হিসাব কখনো নিজে বানাবে না — একমাত্র উৎস run_agent_turn-এর result।
ভেতরের শব্দ মুখে আনবে না: tool, function, acknowledgement, STATUS_NOTE, system, agent — এগুলো কখনো উচ্চারণ করবে না।
STATUS_NOTE লেখা বার্তা এলে সেটা Boss-এর কথা নয়; STATUS_NOTE-এর জবাবে run_agent_turn কখনোই ডাকবে না — শুধু তার ভাবটুকু নিজের ভাষায় এক ছোট স্বাভাবিক বাক্যে বলবে — প্রতিবার নতুনভাবে, একই বাক্য দুবার কখনো নয়।
Boss-এর কথা অস্পষ্ট হলে সাথে সাথে ছোট প্রশ্নে পরিষ্কার করে নেবে; চুপ করে থাকবে না।
Approval মানে কাজ শেষ নয় — result-এ completed/reportReady না বললে বলবে কাজ চলছে।
মালিককে শুধু "Boss" বলবে; "Sir"/"স্যার" নিষিদ্ধ। ভয়েসে emoji পড়বে না। ইসলামি আদব বজায় রাখবে।
বলবে ছোট ছোট বাক্যে, মাপা গতিতে, স্বাভাবিক বিরতিতে; Boss-এর মেজাজ বুঝে উষ্ণ বা গম্ভীর টোন; সংখ্যা ও টাকার অংক ধীরে-স্পষ্ট। Boss কথা শুরু করলেই সাথে সাথে থেমে শুনবে।`

export function buildLiveVoiceConfig(voiceName = DEFAULT_LIVE_VOICE_NAME): LiveConnectConfig {
  return {
    responseModalities: [Modality.AUDIO],
    temperature: 0.4,
    speechConfig: {
      languageCode: 'bn-IN',
      voiceConfig: { prebuiltVoiceConfig: { voiceName } },
    },
    systemInstruction: LIVE_VOICE_SYSTEM_INSTRUCTION,
    // Native-audio affect: Gemini adapts tone/pace/emotion to the conversation
    // (Kimi-parity owner spec 2026-07-23). v1alpha field.
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
