/**
 * POST /api/assistant/live-session/usage — Gemini Live voice spend.
 *
 * Gemini Live runs client↔Google directly, so there is no server-visible meter:
 * the iOS client reports what it used and this route records it. The pricing
 * itself — and the reasoning behind each method — lives in
 * `@/agent/lib/live-voice-usage`.
 *
 * ── Why this route was rewritten (owner incident 2026-08-07) ──────────────────
 * The original version logged ONE row at hang-up priced as
 * `wall-clock minutes × $0.04`. Two failures fell out of the same call:
 *
 *   1. A session left open overnight (02:35 → 08:02, 5h 27m) was billed as if
 *      every one of those minutes was conversation — $13.09, 90% of the day's
 *      AI spend, for a phone lying on a bed. Wall clock is not usage: the mic
 *      noise gate sends nothing while the room is silent.
 *   2. Because the row was written only at hang-up, spend read $0 for 5.5 hours.
 *      The budget guard and the kill switch were blind while it burned, and an
 *      app crash would have lost the row entirely.
 *
 * So: price what was measured, and write it down as it happens. The client sends
 * deltas during the call keyed `live-voice:{user}:{sessionId}:{seq}`; logCost
 * upserts on dedupKey, so a retry is idempotent and a lost report costs one
 * interval rather than the call.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { logCost } from '@/agent/lib/cost-events'
import { DEFAULT_LIVE_VOICE_MODEL } from '@/agent/lib/live-voice-config'
import {
  priceLiveUsage,
  safeNum,
  audioInPerMillion,
  audioOutPerMillion,
  tokensPerAudioSecond,
  usdPerMinute,
  type LiveUsageReport,
} from '@/agent/lib/live-voice-usage'

export const runtime = 'nodejs'
export const maxDuration = 15

const MAX_SECONDS = 12 * 3600
const MAX_TOKENS = 50_000_000

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  let body: LiveUsageReport
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const priced = priceLiveUsage(body)
  if (!priced) return Response.json({ error: 'no_usage_reported' }, { status: 400 })

  const model = typeof body.model === 'string' && body.model.trim()
    ? body.model.trim().slice(0, 80)
    : DEFAULT_LIVE_VOICE_MODEL

  // Wall clock is kept in units for every method — it is how the 5h27m session
  // was spotted in the first place — but it prices nothing for measured clients.
  const wallSeconds = Math.floor(safeNum(body.seconds, MAX_SECONDS))

  const sessionId = typeof body.sessionId === 'string'
    ? body.sessionId.trim().slice(0, 64)
    : ''
  const seq = Number.isFinite(Number(body.seq))
    ? Math.max(0, Math.min(100_000, Math.floor(Number(body.seq))))
    : 0
  const dedupKey = sessionId
    ? `live-voice:${token.sub}:${sessionId}:${seq}`
    : `live-voice:${token.sub}:${Date.now() - (Date.now() % 10_000)}:${wallSeconds}`

  const row = await logCost({
    provider: 'gemini',
    kind: 'call',
    units: {
      model,
      method: priced.method,
      estimate: priced.method === 'wall-clock' ? 'blended-per-minute' : priced.method,
      duration_seconds: wallSeconds,
      audio_in_seconds: safeNum(body.audioInSeconds, MAX_SECONDS),
      audio_out_seconds: safeNum(body.audioOutSeconds, MAX_SECONDS),
      input_tokens: priced.inputTokens,
      output_tokens: priced.outputTokens,
      session_id: sessionId,
      seq,
      final: body.final === true ? 1 : 0,
      // Google's own usageMetadata, recorded but NOT priced — see the pricing
      // module for why, and what would let us trust it.
      observed_prompt_tokens: safeNum(body.observedPromptTokens, MAX_TOKENS),
      observed_response_tokens: safeNum(body.observedResponseTokens, MAX_TOKENS),
      // What this row was priced with, so a later rate change stays auditable.
      // `units` is flat (Record<string, string | number>) — hence the prefixes.
      rate_in_per_m: audioInPerMillion(),
      rate_out_per_m: audioOutPerMillion(),
      rate_tokens_per_audio_sec: tokensPerAudioSecond(),
      rate_usd_per_min: usdPerMinute(),
    },
    costUsd: priced.costUsd,
    conversationId: typeof body.conversationId === 'string' ? body.conversationId : null,
    dedupKey,
  })

  return Response.json({
    ok: true,
    costUsd: priced.costUsd,
    method: priced.method,
    logged: Boolean(row),
  })
}
