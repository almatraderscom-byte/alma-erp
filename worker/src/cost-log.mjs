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
  gemini_image_standard: 0.039,
  gemini_image_pro: 0.134,
  google_tts_per_million_chars: 16.0,
  twilio_per_minute: 0.014,
  whisper_per_minute: 0.006,
}

export function calcTtsCostUsd(charCount) {
  return Math.round((charCount / 1_000_000) * WORKER_PRICING.google_tts_per_million_chars * 1e6) / 1e6
}

export function calcGeminiImageCostUsd(quality) {
  const rate = quality === 'standard' ? WORKER_PRICING.gemini_image_standard : WORKER_PRICING.gemini_image_pro
  return Math.round(rate * 1e6) / 1e6
}

export function calcTwilioCostUsd(seconds = 60) {
  const minutes = Math.max(seconds / 60, 0.5)
  return Math.round(minutes * WORKER_PRICING.twilio_per_minute * 1e6) / 1e6
}
