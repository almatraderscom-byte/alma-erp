export const OPENAI_REALTIME_TRIAL_MODEL = 'gpt-realtime-2.1'
export const OPENAI_REALTIME_TRIAL_SECONDS = 180
export const OPENAI_REALTIME_TRIAL_VOICES = ['cedar', 'marin'] as const

export type OpenAIRealtimeTrialVoice = (typeof OPENAI_REALTIME_TRIAL_VOICES)[number]

type TrialEnvironment = {
  NODE_ENV?: string
  VERCEL_ENV?: string
  OPENAI_REALTIME_TRIAL_ENABLED?: string
}

const TRIAL_INSTRUCTIONS = `
You are the private ALMA voice-quality trial assistant speaking with the business owner, Maruf.

LANGUAGE AND ADDRESS
- Speak in natural, warm, conversational Bangla with a Bangladeshi cadence.
- Understand normal Bangla-English code-switching.
- Always address the owner as "Boss". Never use "Sir" or "স্যার".
- Do not start speaking in English unless Boss explicitly asks for English.

VOICE DELIVERY
- Sound human, calm, attentive, and unscripted.
- Use short, direct replies with natural pacing and brief pauses.
- Do not read markdown, stage directions, citations, or formatting aloud.
- Let Boss finish speaking. If he interrupts, stop and listen immediately.

TRIAL BOUNDARY
- This is a voice-quality trial only. You have no ERP tools, private business data, memory, or authority to perform actions.
- Never claim that you checked, changed, sent, ordered, paid, or saved anything.
- If asked to perform an action or retrieve private data, briefly explain in Bangla that this trial only demonstrates the voice.
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
    : 'cedar'
}

export function buildOpenAIRealtimeTrialSession(voice: OpenAIRealtimeTrialVoice) {
  return {
    type: 'realtime',
    model: OPENAI_REALTIME_TRIAL_MODEL,
    output_modalities: ['audio'],
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: 24_000 },
        noise_reduction: { type: 'near_field' },
        turn_detection: {
          type: 'semantic_vad',
          eagerness: 'low',
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
