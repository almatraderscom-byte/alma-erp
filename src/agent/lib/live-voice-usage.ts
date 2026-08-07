/**
 * Pricing for Gemini Live voice usage (owner incident 2026-08-07).
 *
 * Gemini Live runs client↔Google directly, so there is no server-visible meter —
 * the iOS client reports what it used and this module turns that into money. It
 * is the pure core behind POST /api/assistant/live-session/usage.
 *
 * The rule it exists to enforce: price what was MEASURED, never wall clock. A
 * session left open overnight (5h 27m, phone on a bed, mic noise gate sending
 * nothing) was billed as 5.5 hours of conversation — $13.09, 90% of that day's
 * AI spend. Silence must cost what silence costs.
 *
 * Three methods, best first, picked by what the client can supply:
 *
 *   'tokens'      Google's own usageMetadata counts. Exact. Not yet emitted by
 *                 the app — the Live API reference is unreachable from our
 *                 network, so whether those counts are per-message or cumulative
 *                 is unverified and assuming wrong would mis-bill by orders of
 *                 magnitude. The client records them alongside instead, so the
 *                 switch can be made against a real call with evidence.
 *   'audio'       Seconds of audio actually streamed — uplink measured after the
 *                 noise gate, downlink as received — converted at the documented
 *                 audio token rate. This is what the app reports today.
 *   'wall-clock'  Legacy fallback for builds ≤ 98, which can only report elapsed
 *                 time. Available ONLY to clients with no sessionId: a client
 *                 filing measured deltas has already priced its audio, and
 *                 letting its final report fall through here would bill the call
 *                 twice.
 *
 * Rates are env-tunable (no redeploy) and default to Google's published Live API
 * audio pricing, verified 2026-08-07 against
 * https://cloud.google.com/vertex-ai/generative-ai/pricing
 * ($3 / 1M audio input tokens, $12 / 1M audio output tokens).
 */

export type LiveUsageReport = {
  /** Present once the client reports measured deltas (build 99+). */
  sessionId?: string
  seq?: number
  final?: boolean
  /** Deltas since the client's previous report. */
  audioInSeconds?: number
  audioOutSeconds?: number
  inputTokens?: number
  outputTokens?: number
  /** Raw usageMetadata seen on the wire — recorded for verification, never priced. */
  observedPromptTokens?: number
  observedResponseTokens?: number
  /** Wall-clock elapsed. Diagnostics on every method; pricing only for legacy clients. */
  seconds?: number
  model?: string
  conversationId?: string
}

export type LiveUsagePricing = {
  costUsd: number
  method: 'tokens' | 'audio' | 'wall-clock'
  inputTokens: number
  outputTokens: number
}

function envNum(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback
}

/** $ per 1M audio INPUT tokens (what we send Google). */
export const audioInPerMillion = () => envNum('LIVE_VOICE_AUDIO_IN_PER_M', 3.0)
/** $ per 1M audio OUTPUT tokens (what Google speaks back). */
export const audioOutPerMillion = () => envNum('LIVE_VOICE_AUDIO_OUT_PER_M', 12.0)
/** The Live API bills audio at a fixed token rate per second of audio. */
export const tokensPerAudioSecond = () => envNum('LIVE_VOICE_TOKENS_PER_AUDIO_SEC', 25)

/**
 * Legacy wall-clock rate, used ONLY when a client cannot report measured usage.
 * Derived from the rates above rather than guessed: one wall-clock minute of a
 * live call is ~1 minute of uplink audio ($0.0045) plus the share of it the model
 * spends speaking, ~40% of $0.018 ($0.0072), plus tool-call text — call it
 * $0.015/min. The previous $0.04 was ~3x that, and is what turned one forgotten
 * night into a $13 line item.
 */
export const usdPerMinute = () => envNum('LIVE_VOICE_USD_PER_MIN', 0.015)

/** Non-negative, finite, bounded number from untrusted JSON — or 0. */
export function safeNum(v: unknown, max: number): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(n, max)
}

const MAX_TOKENS = 50_000_000
const MAX_SECONDS = 12 * 3600

/**
 * Price one usage report. Returns null when the report carries nothing priceable,
 * so the caller can reject it instead of writing a $0 row. Never returns a
 * negative or non-finite cost.
 */
export function priceLiveUsage(body: LiveUsageReport): LiveUsagePricing | null {
  const inPerTok = audioInPerMillion() / 1_000_000
  const outPerTok = audioOutPerMillion() / 1_000_000

  // 1 — Google's own token counts. Nothing beats the provider's meter.
  const tokIn = safeNum(body.inputTokens, MAX_TOKENS)
  const tokOut = safeNum(body.outputTokens, MAX_TOKENS)
  if (tokIn > 0 || tokOut > 0) {
    return {
      costUsd: tokIn * inPerTok + tokOut * outPerTok,
      method: 'tokens',
      inputTokens: tokIn,
      outputTokens: tokOut,
    }
  }

  // 2 — audio seconds actually streamed, converted at the documented rate.
  const audioIn = safeNum(body.audioInSeconds, MAX_SECONDS)
  const audioOut = safeNum(body.audioOutSeconds, MAX_SECONDS)
  if (audioIn > 0 || audioOut > 0) {
    const tps = tokensPerAudioSecond()
    const derivedIn = audioIn * tps
    const derivedOut = audioOut * tps
    return {
      costUsd: derivedIn * inPerTok + derivedOut * outPerTok,
      method: 'audio',
      inputTokens: Math.round(derivedIn),
      outputTokens: Math.round(derivedOut),
    }
  }

  // 3 — legacy wall clock, and only for a client with no measured session.
  if (typeof body.sessionId === 'string' && body.sessionId.trim()) return null
  const secs = Math.floor(safeNum(body.seconds, MAX_SECONDS))
  if (secs > 0) {
    return {
      costUsd: (secs / 60) * usdPerMinute(),
      method: 'wall-clock',
      inputTokens: 0,
      outputTokens: 0,
    }
  }

  return null
}
