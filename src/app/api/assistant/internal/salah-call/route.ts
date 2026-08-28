/**
 * POST /api/assistant/internal/salah-call — place a TWO-WAY live agent call to
 * the OWNER'S NUMBER for a salah reminder (owner rule 2026-08-28: in BD the
 * salah call must be the live দুইমুখী call on his number, not the one-way TTS
 * reminder). Rides the normal placeOutboundCall pipeline (self-hosted SIP live
 * bot, owner persona) with capExempt — salah has its own cadence guards.
 *
 * Body: { brief: string, waqt?: string, date?: string (YYYY-MM-DD) }
 * Auth: Bearer AGENT_INTERNAL_TOKEN. The caller (VPS salah scheduler) checks
 * confirm/lock/gap up front, but this route RE-CHECKS confirmation and the
 * owner-call-lock immediately before dialing (review-bot P2): the owner may
 * have confirmed or locked mid-flight, and ringing then bypasses exactly what
 * he asked for. placeOutboundCall re-checks the abroad toggle.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { placeOutboundCall, getVoiceCallConfig } from '@/agent/lib/voice-call'
import { ownerPrimaryNumber } from '@/agent/lib/proactive-call'
import { isOwnerCallLocked } from '@/lib/owner-call-lock'
import { prisma } from '@/lib/prisma'

const SETTLED = new Set(['prayed_on_time', 'prayed_late', 'qaza'])

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

  const body = await req.json().catch(() => ({})) as { brief?: unknown; waqt?: unknown; date?: unknown }
  const brief = typeof body.brief === 'string' ? body.brief.trim().slice(0, 2000) : ''
  if (!brief) return NextResponse.json({ ok: false, error: 'brief লাগবে' }, { status: 400 })

  const toNumber = ownerPrimaryNumber()
  if (!toNumber) return NextResponse.json({ ok: false, error: 'OWNER_PHONE_NUMBERS empty' }, { status: 400 })

  // Only providers that report their transcript to relay-report can honor a
  // spoken "পড়েছি" (the auto-mark lives there). ElevenLabs reports to the
  // legacy webhook with no salah hook — refusing here makes the scheduler
  // fall back to the one-way reminder instead of silently losing
  // confirmations (review-bot P1).
  const provider = getVoiceCallConfig().provider
  if (provider === 'elevenlabs') {
    return NextResponse.json({ ok: false, error: 'provider_unsupported_for_salah' }, { status: 400 })
  }

  const waqt = typeof body.waqt === 'string' ? body.waqt.slice(0, 20) : null
  const date = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : null
  // The date rides in the purpose tag too: the post-call auto-mark must target
  // the day that TRIGGERED the call, not the day the report lands (midnight
  // crossing / delayed durable report — review-bot P1).
  const purposeTag = waqt ? (date ? `[salah:${waqt}:${date}] ` : `[salah:${waqt}] `) : ''

  // Terminal guards: checked here (fast fail, no row created) AND re-run by
  // placeOutboundCall as a preDialCheck right before the gateway fetch — the
  // owner may confirm or lock during the slow prep work (review-bot P2).
  const terminalVeto = async (): Promise<string | null> => {
    const lock = await isOwnerCallLocked().catch(() => ({ locked: false }))
    if (lock.locked) return 'owner_call_locked'
    if (waqt && date) {
      const rec = await prisma.agentSalahRecord.findUnique({
        where: { date_waqt: { date: new Date(`${date}T00:00:00Z`), waqt } },
        select: { status: true, confirmedAt: true },
      }).catch(() => null)
      if (rec && (SETTLED.has(rec.status) || rec.confirmedAt)) return 'salah_confirmed'
    }
    return null
  }
  const early = await terminalVeto()
  if (early) return NextResponse.json({ ok: false, error: early }, { status: 409 })
  const res = await placeOutboundCall({
    toNumber,
    recipientName: 'Boss',
    purpose: `${purposeTag}${brief}`,
    firstMessage: '',
    callType: 'owner',
    channel: 'phone',
    capExempt: true,
    preDialCheck: terminalVeto,
  })
  return NextResponse.json(res, { status: res.ok ? 200 : 502 })
}
