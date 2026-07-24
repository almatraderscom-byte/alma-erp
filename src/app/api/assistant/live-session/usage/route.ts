import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { logCost } from '@/agent/lib/cost-events'
import { DEFAULT_LIVE_VOICE_MODEL } from '@/agent/lib/live-voice-config'

export const runtime = 'nodejs'
export const maxDuration = 15

// Gemini Live (native-audio) has no server-visible meter here — the session runs
// client↔Google directly. The client reports the call duration at hang-up and we
// log an ESTIMATE so voice-call spend is visible in the cost dashboard instead of
// invisible (owner 2026-07-24: "voice agent-এর cost-এর হিসাব কোথাও পাই না").
// Blended $/minute is env-tunable; verify against ai.google.dev/pricing and tune
// LIVE_VOICE_USD_PER_MIN without a redeploy.
const usdPerMinute = (): number => {
  const raw = Number(process.env.LIVE_VOICE_USD_PER_MIN)
  return Number.isFinite(raw) && raw >= 0 ? raw : 0.04
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  let body: { seconds?: number; model?: string; conversationId?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const seconds = Math.floor(Number(body.seconds))
  // 12h hard cap keeps a bad client from logging an absurd cost row.
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 12 * 3600) {
    return Response.json({ error: 'seconds_invalid' }, { status: 400 })
  }

  const model = typeof body.model === 'string' && body.model.trim()
    ? body.model.trim().slice(0, 80)
    : DEFAULT_LIVE_VOICE_MODEL
  const costUsd = (seconds / 60) * usdPerMinute()

  const row = await logCost({
    provider: 'gemini',
    kind: 'call',
    units: {
      duration_seconds: seconds,
      model,
      estimate: 'blended-per-minute',
      usd_per_min: usdPerMinute(),
    },
    costUsd,
    conversationId: typeof body.conversationId === 'string' ? body.conversationId : null,
    dedupKey: `live-voice:${token.sub}:${Date.now() - (Date.now() % 10_000)}:${seconds}`,
  })

  return Response.json({ ok: true, costUsd, logged: Boolean(row) })
}
