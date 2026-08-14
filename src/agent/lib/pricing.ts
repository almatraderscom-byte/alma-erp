/**
 * Centralized AI provider pricing — USD.
 * lastVerifiedAt: date we last checked the provider's public pricing page.
 * verified: true when confirmed on official docs; false = estimate, use with caution.
 */

export const COST_PROVIDERS = [
  'anthropic',
  'openai',
  'xai',
  'openrouter',
  'gemini',
  'veo',
  'google_tts',
  'twilio',
  'elevenlabs',
  'oxylabs',
  'fal',
  'fashn',
] as const

export type CostProvider = (typeof COST_PROVIDERS)[number]

const COST_PROVIDER_SET: ReadonlySet<string> = new Set(COST_PROVIDERS)

export function isCostProvider(value: unknown): value is CostProvider {
  return typeof value === 'string' && COST_PROVIDER_SET.has(value)
}

export type CostKind =
  | 'chat'
  | 'embedding'
  | 'transcribe'
  | 'tts'
  | 'image'
  | 'video'
  | 'call'
  | 'cs_chat'
  | 'cs_vision'
  | 'qc_vision'
  | 'cs_comment_classify'
  | 'web_research'

export const PRICING_META = {
  anthropic: {
    model: 'claude-sonnet-4-6',
    lastVerifiedAt: '2026-06-12',
    verified: true,
    source: 'https://docs.anthropic.com/en/docs/about-claude/pricing',
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
    cacheWritePerMillion: 3.75,
    cacheReadPerMillion: 0.3,
  },
  openai_embedding: {
    model: 'text-embedding-3-small',
    lastVerifiedAt: '2026-06-12',
    verified: true,
    source: 'https://developers.openai.com/api/docs/models/text-embedding-3-small',
    perMillionTokens: 0.02,
  },
  openai_whisper: {
    // Bangla STT now runs on gpt-4o-transcribe (far better Bangla than whisper-1),
    // billed at the same ~$0.006/min estimate. whisper-1 remains the fallback.
    model: 'gpt-4o-transcribe',
    lastVerifiedAt: '2026-06-23',
    verified: true,
    source: 'https://platform.openai.com/docs/models/gpt-4o-transcribe',
    perMinute: 0.006,
  },
  gemini_image_standard: {
    model: 'gemini-3.1-flash-image',
    lastVerifiedAt: '2026-06-15',
    verified: false,
    source: 'https://ai.google.dev/gemini-api/docs/pricing',
    perImage1K: 0.067,
    perImage2K: 0.101,
    perImage4K: 0.151,
    perImage: 0.101,
    note: 'Flash image GA (Nano Banana 2) — per-image by output resolution; default 2K',
  },
  gemini_image_pro: {
    model: 'gemini-3-pro-image',
    lastVerifiedAt: '2026-06-15',
    verified: false,
    source: 'https://ai.google.dev/gemini-api/docs/pricing',
    perImage1K: 0.134,
    perImage2K: 0.134,
    perImage4K: 0.24,
    perImage: 0.134,
    note: 'Pro image GA (Nano Banana Pro) — 1K/2K same rate; default 2K',
  },
  veo_video: {
    model: 'veo-3.1-generate-preview',
    lastVerifiedAt: '2026-06-15',
    verified: false,
    source: 'https://ai.google.dev/gemini-api/docs/pricing',
    perSecond: 0.15,
    note: 'Veo 3.1 image-to-video estimate ~$0.15/sec — hero reels only',
  },
  google_tts: {
    model: 'bn-IN-Chirp3-HD-Charon',
    lastVerifiedAt: '2026-06-12',
    verified: false,
    source: 'https://cloud.google.com/text-to-speech/pricing',
    perMillionChars: 16.0,
    note: 'Chirp HD tier estimate — verify Cloud TTS pricing',
  },
  twilio_voice: {
    model: 'outbound-us',
    lastVerifiedAt: '2026-06-12',
    verified: false,
    source: 'https://www.twilio.com/en-us/voice/pricing/us',
    perMinute: 0.014,
    note: 'US outbound estimate; actual rate varies by destination',
  },
  elevenlabs_tts: {
    model: 'eleven_v3',
    lastVerifiedAt: '2026-08-14',
    verified: false,
    source: 'https://elevenlabs.io/pricing/api',
    perMillionChars: 100.0,
    note: 'Multilingual v3 ~$0.10/1k chars (credit-plan dependent) — Media mode VO',
  },
  elevenlabs_music: {
    model: 'eleven_music',
    lastVerifiedAt: '2026-08-14',
    verified: false,
    source: 'https://elevenlabs.io/pricing/api',
    perMinute: 0.5,
    note: 'Music generation estimate — verify against credit burn before M2 ships',
  },
  seedance_video: {
    model: 'fal-ai/bytedance/seedance/v1/pro',
    lastVerifiedAt: '2026-08-14',
    verified: false,
    source: 'https://fal.ai/models/fal-ai/bytedance/seedance/v1/pro',
    perSecondPro: 0.125,
    perSecondLite: 0.037,
    note: 'Seedance via fal (~$0.62/5s pro 1080p, ~$0.18/5s lite) — verify exact fal rate at M2 wiring',
  },
} as const

/** Anthropic chat cost from token usage (matches legacy calcCostUsd). */
export function calcAnthropicChatCostUsd(
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number | null
    cache_read_input_tokens?: number | null
  },
  opts?: { batch?: boolean },
): number {
  const p = PRICING_META.anthropic
  const input = (usage.input_tokens / 1_000_000) * p.inputPerMillion
  const output = (usage.output_tokens / 1_000_000) * p.outputPerMillion
  const cacheWrite = ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) * p.cacheWritePerMillion
  const cacheRead = ((usage.cache_read_input_tokens ?? 0) / 1_000_000) * p.cacheReadPerMillion
  const base = input + output + cacheWrite + cacheRead
  const discounted = opts?.batch ? base * 0.5 : base
  return roundUsd(discounted)
}

export function calcEmbeddingCostUsd(tokenCount: number): number {
  return roundUsd((tokenCount / 1_000_000) * PRICING_META.openai_embedding.perMillionTokens)
}

/** Estimate tokens from text when API does not return usage. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

export function calcWhisperCostUsd(durationSeconds: number): number {
  const minutes = Math.max(durationSeconds / 60, 0.01)
  return roundUsd(minutes * PRICING_META.openai_whisper.perMinute)
}

/** Estimate audio duration from byte size (OGG/MP3 ~16kbps telephony average). */
export function estimateAudioDurationSeconds(byteLength: number): number {
  return Math.max(1, Math.ceil(byteLength / 2000))
}

/**
 * EXACT duration from a WAV/RIFF header — dataSize / byteRate. Returns null when
 * the bytes are not a parseable PCM WAV (compressed formats have no such header),
 * so callers fall back to the byte estimate.
 *
 * Why this exists (cost audit Phase 6, 2026-07-25): the office-camera listener
 * uploads WAV 16 kHz mono 16-bit chunks = 32000 bytes/sec, but the byte estimate
 * assumes ~2000 B/s — a 16× duration over-count that alone billed the dashboard
 * ~$17/month of "OpenAI" against a real bill of ~$1. Reading the header removes
 * the guess.
 */
export function wavDurationSeconds(bytes: Uint8Array): number | null {
  // Need at least the 12-byte RIFF/WAVE header before the first chunk.
  if (bytes.length < 44) return null
  const ascii = (o: number, n: number) => String.fromCharCode(...bytes.subarray(o, o + n))
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  let byteRate = 0
  let dataSize = 0
  // Walk the chunk list: [4-byte id][4-byte LE size][payload, padded to even].
  let off = 12
  while (off + 8 <= bytes.length) {
    const id = ascii(off, 4)
    const size = dv.getUint32(off + 4, true)
    if (id === 'fmt ' && off + 16 <= bytes.length) {
      byteRate = dv.getUint32(off + 16, true) // bytes/sec, 8 bytes into the fmt payload
    } else if (id === 'data') {
      // The data chunk size can be understated in streamed WAVs; clamp to what is
      // actually present so a truncated header can't inflate the duration.
      dataSize = Math.min(size, bytes.length - (off + 8))
      break
    }
    off += 8 + size + (size % 2) // chunks are word-aligned
  }
  if (byteRate <= 0 || dataSize <= 0) return null
  return Math.max(dataSize / byteRate, 0.01)
}

/**
 * Best-available audio duration: exact when the bytes are WAV, otherwise the
 * byte-size estimate. One entry point so every transcribe path gets the accurate
 * number when it can and degrades gracefully when it can't.
 */
export function audioDurationSeconds(bytes: Uint8Array, byteLength = bytes.length): number {
  return wavDurationSeconds(bytes) ?? estimateAudioDurationSeconds(byteLength)
}

export function calcTtsCostUsd(charCount: number): number {
  return roundUsd((charCount / 1_000_000) * PRICING_META.google_tts.perMillionChars)
}

export function calcGeminiImageCostUsd(
  quality: 'standard' | 'pro',
  imageSize: '1K' | '2K' | '4K' = '2K',
): number {
  const p = quality === 'standard' ? PRICING_META.gemini_image_standard : PRICING_META.gemini_image_pro
  const rate =
    imageSize === '1K' ? p.perImage1K
      : imageSize === '4K' ? p.perImage4K
        : p.perImage2K
  return roundUsd(rate)
}

/** Veo 3.1 video — ~$0.15 per second (estimate). */
export function calcVeoCostUsd(durationSeconds: number): number {
  const secs = Math.max(1, Math.round(durationSeconds))
  return roundUsd(secs * PRICING_META.veo_video.perSecond)
}

/** ElevenLabs TTS — per-character (Media mode VO). */
export function calcElevenLabsTtsCostUsd(charCount: number): number {
  return roundUsd((Math.max(0, charCount) / 1_000_000) * PRICING_META.elevenlabs_tts.perMillionChars)
}

/** ElevenLabs Music — per generated minute (estimate). The worker clamps
 * music_length_ms to ≥10s (audio-lab.mjs), so the quote floors there too. */
export const ELEVENLABS_MUSIC_MIN_SECONDS = 10
export function calcElevenLabsMusicCostUsd(durationSeconds: number): number {
  const minutes = Math.max(durationSeconds, ELEVENLABS_MUSIC_MIN_SECONDS) / 60
  return roundUsd(minutes * PRICING_META.elevenlabs_music.perMinute)
}

/** Seedance (fal) image-to-video — per second, pro/lite tier. */
export function calcSeedanceCostUsd(durationSeconds: number, tier: 'pro' | 'lite' = 'pro'): number {
  const secs = Math.max(1, Math.round(durationSeconds))
  const rate = tier === 'lite' ? PRICING_META.seedance_video.perSecondLite : PRICING_META.seedance_video.perSecondPro
  return roundUsd(secs * rate)
}

export function calcTwilioCallCostUsd(durationSeconds = 60): number {
  const minutes = Math.max(durationSeconds / 60, 0.5)
  return roundUsd(minutes * PRICING_META.twilio_voice.perMinute)
}

export function roundUsd(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000
}

/** Monthly subscription amortized to daily USD (for forecast). */
export function subscriptionDailyUsd(amount: number, cycle: 'monthly' | 'yearly'): number {
  if (cycle === 'yearly') return amount / 365
  return amount / 30
}
