/**
 * Centralized AI provider pricing — USD.
 * lastVerifiedAt: date we last checked the provider's public pricing page.
 * verified: true when confirmed on official docs; false = estimate, use with caution.
 */

export type CostProvider =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'google_tts'
  | 'twilio'
  | 'elevenlabs'

export type CostKind =
  | 'chat'
  | 'embedding'
  | 'transcribe'
  | 'tts'
  | 'image'
  | 'call'

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
    model: 'whisper-1',
    lastVerifiedAt: '2026-06-12',
    verified: true,
    source: 'https://platform.openai.com/docs/models/whisper-1',
    perMinute: 0.006,
  },
  gemini_image_standard: {
    model: 'gemini-3.1-flash-image-preview',
    lastVerifiedAt: '2026-06-12',
    verified: false,
    source: 'https://ai.google.dev/gemini-api/docs/pricing',
    perImage: 0.039,
    note: 'Flash image — verify on Google AI pricing page',
  },
  gemini_image_pro: {
    model: 'gemini-3-pro-image-preview',
    lastVerifiedAt: '2026-06-12',
    verified: false,
    source: 'https://ai.google.dev/gemini-api/docs/pricing',
    perImage: 0.134,
    note: 'Pro image — estimate; verify on Google AI pricing page',
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
} as const

/** Anthropic chat cost from token usage (matches legacy calcCostUsd). */
export function calcAnthropicChatCostUsd(usage: {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
}): number {
  const p = PRICING_META.anthropic
  const input = (usage.input_tokens / 1_000_000) * p.inputPerMillion
  const output = (usage.output_tokens / 1_000_000) * p.outputPerMillion
  const cacheWrite = ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) * p.cacheWritePerMillion
  const cacheRead = ((usage.cache_read_input_tokens ?? 0) / 1_000_000) * p.cacheReadPerMillion
  return roundUsd(input + output + cacheWrite + cacheRead)
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

export function calcTtsCostUsd(charCount: number): number {
  return roundUsd((charCount / 1_000_000) * PRICING_META.google_tts.perMillionChars)
}

export function calcGeminiImageCostUsd(quality: 'standard' | 'pro'): number {
  const p = quality === 'standard' ? PRICING_META.gemini_image_standard : PRICING_META.gemini_image_pro
  return roundUsd(p.perImage)
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
