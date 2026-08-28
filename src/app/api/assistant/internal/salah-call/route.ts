/**
 * POST /api/assistant/internal/salah-call — place a TWO-WAY live agent call to
 * the OWNER'S NUMBER for a salah reminder (owner rule 2026-08-28: in BD the
 * salah call must be the live দুইমুখী call on his number, not the one-way TTS
 * reminder). Rides the normal placeOutboundCall pipeline (self-hosted SIP live
 * bot, owner persona) with capExempt — salah has its own cadence guards.
 *
 * Body: { brief: string, waqt?: string }
 * Auth: Bearer AGENT_INTERNAL_TOKEN. Caller (VPS salah scheduler) has already
 * checked confirm/lock/gap; placeOutboundCall re-checks the abroad toggle.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { placeOutboundCall } from '@/agent/lib/voice-call'
import { ownerPrimaryNumber } from '@/agent/lib/proactive-call'

export const runtime = 'nodejs'

function checkToken(req: NextRequest): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN
  if (!expected) return false
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  } catch {
    return false
  }
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  if (!checkToken(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({})) as { brief?: unknown; waqt?: unknown }
  const brief = typeof body.brief === 'string' ? body.brief.trim().slice(0, 2000) : ''
  if (!brief) return NextResponse.json({ ok: false, error: 'brief লাগবে' }, { status: 400 })

  const toNumber = ownerPrimaryNumber()
  if (!toNumber) return NextResponse.json({ ok: false, error: 'OWNER_PHONE_NUMBERS empty' }, { status: 400 })

  const waqt = typeof body.waqt === 'string' ? body.waqt.slice(0, 20) : null
  const res = await placeOutboundCall({
    toNumber,
    recipientName: 'Boss',
    purpose: waqt ? `[salah:${waqt}] ${brief}` : brief,
    firstMessage: '',
    callType: 'owner',
    channel: 'phone',
    capExempt: true,
  })
  return NextResponse.json(res, { status: res.ok ? 200 : 502 })
}
