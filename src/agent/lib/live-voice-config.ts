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

export const LIVE_VOICE_SYSTEM_INSTRUCTION = `তুমি ALMA-এর realtime voice transport। তুমি শুধু Boss-এর সাথে কথা বলছ।
- Boss যা বলেন, opening greeting ছাড়া প্রতিটি বক্তব্য বা অনুরোধে run_agent_turn টুলটি ঠিক একবার চালাবে। নিজে থেকে ব্যবসার তথ্য, স্মৃতি, হিসাব বা action বানাবে না।
- টুল চালানোর আগে দরকার হলে শুধু খুব ছোট একটি স্বাভাবিক acknowledgement বলতে পারো।
- টুলের result পাওয়ার পর result-এর কথাই স্বাভাবিক, সংক্ষিপ্ত বাংলায় বলবে; নতুন তথ্য বা completion claim যোগ করবে না।
- Approval পাওয়া মানে asynchronous কাজ শেষ নয়। Result যদি বলে কাজ চলছে, তাহলে কাজ চলছে বলবে; completed/report-ready না হওয়া পর্যন্ত শেষ হয়েছে বলবে না।
- মালিককে সবসময় শুধু “Boss” বলবে; অন্য কোনো সম্বোধন ব্যবহার করবে না। ভয়েসে emoji পড়বে না। ইসলামি আদব বজায় রাখবে।
- Boss কথা শুরু করলে সঙ্গে সঙ্গে থামবে এবং শুনবে।`

export function buildLiveVoiceConfig(voiceName = DEFAULT_LIVE_VOICE_NAME): LiveConnectConfig {
  return {
    responseModalities: [Modality.AUDIO],
    temperature: 0.4,
    speechConfig: {
      languageCode: 'bn-IN',
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
        startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
        endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
        prefixPaddingMs: 80,
        silenceDurationMs: 500,
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

/** Token constraints deliberately leave only the resumption handle client-settable.
 * Every safety/voice/tool field remains server-locked, while a rotating websocket
 * can attach the latest Google-issued handle without minting a broad API key. */
export function buildLiveVoiceTokenConfig(voiceName = DEFAULT_LIVE_VOICE_NAME): LiveConnectConfig {
  const config = buildLiveVoiceConfig(voiceName)
  const { sessionResumption: _clientHandle, ...locked } = config
  return locked
}
