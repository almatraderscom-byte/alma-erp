export const OPENAI_REALTIME_TRIAL_MODEL = 'gpt-realtime-2.1'
export const OPENAI_REALTIME_TRIAL_SECONDS = 180
export const OPENAI_REALTIME_TRIAL_VOICES = ['cedar', 'marin'] as const
export const OPENAI_REALTIME_INPUT_PROFILES = ['far_field', 'near_field'] as const

export type OpenAIRealtimeTrialVoice = (typeof OPENAI_REALTIME_TRIAL_VOICES)[number]
export type OpenAIRealtimeInputProfile = (typeof OPENAI_REALTIME_INPUT_PROFILES)[number]

type AudioInputDescriptor = {
  deviceId: string
  kind: string
  label: string
}

type TrialEnvironment = {
  NODE_ENV?: string
  VERCEL_ENV?: string
  OPENAI_REALTIME_TRIAL_ENABLED?: string
}

const TRIAL_INSTRUCTIONS = `
# ভূমিকা
তুমি ALMA-এর ব্যক্তিগত voice-quality trial assistant। তুমি ব্যবসার মালিক Maruf-এর সঙ্গে সরাসরি কণ্ঠে কথা বলছ।

# ভাষা
- কথোপকথনের মূল ও স্থায়ী ভাষা হবে বাংলাদেশি বাংলা।
- Boss বাংলিশে কথা বললে স্বাভাবিক বাংলাদেশি ভঙ্গিতে বাংলা ও প্রয়োজনীয় English শব্দ মিশিয়ে উত্তর দেবে।
- Boss স্পষ্টভাবে English চাইলে তবেই সম্পূর্ণ English-এ যাবে।
- greeting, clarification এবং সব ছোট spoken bridge-ও একই বাংলাদেশি বাংলায় বলবে।
- মালিককে শুধু "Boss" বলবে। "Sir" বা "স্যার" বলবে না।

# বাংলাদেশি উচ্চারণ
- শিক্ষিত ঢাকাভিত্তিক neutral Bangladeshi Bangla accent-এ কথা বলবে।
- বাংলা স্বরবর্ণ ও ব্যঞ্জনবর্ণ একজন native বাংলাদেশির মতো উচ্চারণ করবে; English vowel shaping দিয়ে বাংলা বলবে না।
- Hindi বা West Bengal/কলকাতার টান আনবে না।
- ব্যবহৃত English শব্দগুলো বাংলাদেশির স্বাভাবিক কথ্য উচ্চারণে বলবে, কিন্তু তাতে বাংলা বাক্যের rhythm বদলাবে না।
- প্রথম শব্দ থেকে শেষ শব্দ পর্যন্ত accent একই রাখবে।

# কণ্ঠ, গতি ও স্বাভাবিকতা
- কণ্ঠ হবে উষ্ণ, সতেজ, মনোযোগী ও স্বতঃস্ফূর্ত—পাঠ করে শোনানোর মতো নয়।
- একবারে এক বা দুইটি ছোট বাক্য বলবে।
- স্বাভাবিক শ্বাস, ক্ষুদ্র বিরতি ও বাংলাদেশের কথ্য ছন্দ রাখবে; নাটকীয় বা অতিরঞ্জিত হবে না।
- Boss কথা শুরু করলে সঙ্গে সঙ্গে থেমে শুনবে।
- markdown, citation, stage direction, emoji বা formatting মুখে পড়বে না।

# কথার নমুনা
- "আসসালামু আলাইকুম Boss, আমি শুনছি—বলুন।"
- "জি Boss, বুঝেছি।"
- "Boss, শেষ কথাটা আরেকবার বলবেন?"
- নমুনাগুলোর স্বাভাবিক বাংলাদেশি ছন্দ অনুসরণ করবে, কিন্তু একই বাক্য অকারণে বারবার বলবে না।

# অস্পষ্ট অডিও
- কথা পরিষ্কার না শুনলে অনুমান করবে না।
- ছোট করে বলবে: "Boss, শেষ কথাটা আরেকবার বলবেন?"
- নীরবতা বা background শব্দকে প্রশ্ন ধরে উত্তর দেবে না।

# ট্রায়ালের সীমা
- এটি শুধু voice-quality trial। তোমার কাছে ERP tool, private business data, memory বা কোনো action নেওয়ার ক্ষমতা নেই।
- কিছু check, change, send, order, pay বা save করেছ—এমন দাবি করবে না।
- কোনো business action চাইলে সংক্ষেপে বাংলায় বলবে যে এই trial শুধু voice পরীক্ষা করছে।
`.trim()

export function isOpenAIRealtimeTrialEnabled(env: TrialEnvironment = process.env): boolean {
  const explicit = env.OPENAI_REALTIME_TRIAL_ENABLED?.trim().toLowerCase()
  if (explicit === 'false') return false
  if (explicit === 'true') return true
  return env.VERCEL_ENV === 'preview' || env.NODE_ENV === 'development'
}

export function parseOpenAIRealtimeTrialVoice(value: string | null): OpenAIRealtimeTrialVoice {
  return OPENAI_REALTIME_TRIAL_VOICES.includes(value as OpenAIRealtimeTrialVoice)
    ? value as OpenAIRealtimeTrialVoice
    : 'marin'
}

export function parseOpenAIRealtimeInputProfile(value: string | null): OpenAIRealtimeInputProfile {
  return OPENAI_REALTIME_INPUT_PROFILES.includes(value as OpenAIRealtimeInputProfile)
    ? value as OpenAIRealtimeInputProfile
    : 'far_field'
}

export function selectPreferredAudioInput(
  devices: readonly AudioInputDescriptor[],
  currentLabel: string,
): string | null {
  if (!/iphone|ipad|continuity/i.test(currentLabel)) return null

  const builtIn = devices.find(device => (
    device.kind === 'audioinput'
    && /macbook|built-in|internal microphone/i.test(device.label)
    && !/iphone|ipad|continuity/i.test(device.label)
  ))

  return builtIn?.deviceId || null
}

export function buildOpenAIRealtimeTrialSession(
  voice: OpenAIRealtimeTrialVoice,
  inputProfile: OpenAIRealtimeInputProfile = 'far_field',
) {
  return {
    type: 'realtime',
    model: OPENAI_REALTIME_TRIAL_MODEL,
    output_modalities: ['audio'],
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: 24_000 },
        noise_reduction: { type: inputProfile },
        transcription: {
          model: 'gpt-4o-transcribe',
          language: 'bn',
          prompt: 'বাংলাদেশি বাংলা, ঢাকার স্বাভাবিক উচ্চারণ এবং বাংলা-English code-switching। বক্তা Maruf; সম্বোধন Boss।',
        },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.4,
          prefix_padding_ms: 300,
          silence_duration_ms: 600,
          create_response: true,
          interrupt_response: true,
        },
      },
      output: {
        format: { type: 'audio/pcm' },
        voice,
      },
    },
    reasoning: { effort: 'low' },
    instructions: TRIAL_INSTRUCTIONS,
  }
}
