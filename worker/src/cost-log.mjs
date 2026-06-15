/**
 * Worker-side cost logging via app internal API.
 */

const APP_URL = () => (process.env.APP_URL ?? '').replace(/\/$/, '')
const INT_TOKEN = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

/**
 * @param {object} params
 * @param {string} params.provider
 * @param {string} params.kind
 * @param {Record<string, unknown>} params.units
 * @param {number} params.costUsd
 * @param {string} [params.conversationId]
 * @param {string} [params.jobId]
 * @param {string} [params.dedupKey]
 */
export async function logCost(params) {
  try {
    const res = await fetch(`${APP_URL()}/api/assistant/internal/cost-event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${INT_TOKEN()}`,
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      console.warn(`[cost-log] HTTP ${res.status}`)
    }
  } catch (err) {
    console.warn('[cost-log] failed:', err.message)
  }
}

/** Pricing mirrors src/agent/lib/pricing.ts (keep in sync). */
export const WORKER_PRICING = {
  anthropic_input_per_million: 3.0,
  anthropic_output_per_million: 15.0,
  anthropic_cache_write_per_million: 3.75,
  anthropic_cache_read_per_million: 0.3,
  gemini_image_standard_1k: 0.067,
  gemini_image_standard_2k: 0.101,
  gemini_image_standard_4k: 0.151,
  gemini_image_pro_1k: 0.134,
  gemini_image_pro_2k: 0.134,
  gemini_image_pro_4k: 0.24,
  google_tts_per_million_chars: 16.0,
  twilio_per_minute: 0.014,
  whisper_per_minute: 0.006,
}

/**
 * @param {{ input_tokens?: number, output_tokens?: number, cache_creation_input_tokens?: number, cache_read_input_tokens?: number }} usage
 * @param {{ batch?: boolean }} [opts] — batch API = 50% of standard token price
 */
export function calcAnthropicChatCostUsd(usage, opts = {}) {
  const p = WORKER_PRICING
  const input = ((usage.input_tokens ?? 0) / 1_000_000) * p.anthropic_input_per_million
  const output = ((usage.output_tokens ?? 0) / 1_000_000) * p.anthropic_output_per_million
  const cacheWrite = ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) * p.anthropic_cache_write_per_million
  const cacheRead = ((usage.cache_read_input_tokens ?? 0) / 1_000_000) * p.anthropic_cache_read_per_million
  const base = input + output + cacheWrite + cacheRead
  const discounted = opts.batch ? base * 0.5 : base
  return Math.round(discounted * 1_000_000) / 1_000_000
}

export function calcTtsCostUsd(charCount) {
  return Math.round((charCount / 1_000_000) * WORKER_PRICING.google_tts_per_million_chars * 1e6) / 1e6
}

export function calcGeminiImageCostUsd(quality, imageSize = '2K') {
  const q = quality === 'standard' ? 'standard' : 'pro'
  const size = imageSize === '1K' ? '1k' : imageSize === '4K' ? '4k' : '2k'
  const key = `gemini_image_${q}_${size}`
  const rate = WORKER_PRICING[key] ?? WORKER_PRICING[`gemini_image_${q}_2k`]
  return Math.round(rate * 1e6) / 1e6
}

export function calcTwilioCostUsd(seconds = 60) {
  const minutes = Math.max(seconds / 60, 0.5)
  return Math.round(minutes * WORKER_PRICING.twilio_per_minute * 1e6) / 1e6
}
