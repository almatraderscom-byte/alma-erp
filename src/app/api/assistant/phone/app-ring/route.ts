/**
 * POST /api/assistant/phone/app-ring — ring (or stop ringing) the staff iOS apps for an
 * inbound customer call. Called by the SIP gateway on the VPS during the staff-first
 * window; this is the wake path that lets a CLOSED app ring like a real phone.
 *
 *   gateway ──ring──▶ this route ──APNs VoIP push──▶ PKPushRegistry ──▶ CallKit ring
 *                                                     answer ▶ wss://<gateway>/app-media?token=…
 *
 * The push carries a one-time media token minted by the gateway; the app answers by
 * connecting the gateway's /app-media WebSocket with it — first connection wins the
 * call, so this route never has to arbitrate the race. `event:'cancel'` ends the
 * CallKit ring on every device (someone answered elsewhere, the AI took the call, or
 * the caller hung up).
 *
 * Security: reachable without a session (the VPS calls it) — guarded by the same
 * shared secret as sip-inbound (`?k=SIP_INBOUND_SECRET`) + requireAgentEnabled().
 * Everything is fail-open toward the browser ring: a push problem must never break
 * the call that is already ringing the tabs.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { prisma } from '@/lib/prisma'
import { getCallPushTargets } from '@/agent/lib/call-push'
import { apnsVoipConfigured, sendVoipCall } from '@/agent/lib/apns-voip'
import { callerRingDisplay } from '@/agent/lib/phone-contacts'

export const runtime = 'nodejs'
export const maxDuration = 20

function secretOk(provided: string): boolean {
  const expected = process.env.SIP_INBOUND_SECRET ?? process.env.NGS_INBOUND_SECRET ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

type Body = {
  event?: string
  callId?: string
  caller?: string
  token?: string
  expiresAt?: string
  staffIds?: string[]
  reason?: string
}

// Lock-screen caller identity: shared resolver (phonebook → customer + last order),
// so the ring, the screen-pop and the recents all name a number the same way.

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const k = new URL(req.url).searchParams.get('k') ?? ''
  if (!secretOk(k)) return NextResponse.json({ ok: false }, { status: 403 })

  const body = (await req.json().catch(() => ({}))) as Body
  const callId = String(body.callId ?? '').trim()
  if (!callId) return NextResponse.json({ ok: false, error: 'missing callId' }, { status: 400 })

  if (!apnsVoipConfigured()) return NextResponse.json({ ok: true, sent: 0, note: 'apns_unconfigured' })

  const gatewayBase = (process.env.SIP_GATEWAY_BASE ?? '').replace(/\/$/, '')
  const mediaWsUrl = gatewayBase
    ? `${gatewayBase.replace(/^https?:/, gatewayBase.startsWith('https') ? 'wss:' : 'ws:')}/app-media`
    : ''

  try {
    if (body.event === 'cancel') {
      // Audience = every device that might still be ringing. broadcastId matching on the
      // device makes this a no-op for calls it is not showing.
      const rows = (await prisma.pushSubscription.findMany({
        where: { provider: 'apns_voip', enabled: true },
        select: { playerId: true },
      })) as Array<{ playerId: string | null }>
      const tokens = rows.map((r) => r.playerId).filter((t): t is string => Boolean(t))
      const results = await sendVoipCall(tokens, {
        type: 'sip_call',
        broadcastId: callId,
        channel: `sip_${callId}`,
        caller: '',
        event: 'cancel',
        schemaVersion: 1,
      })
      return NextResponse.json({ ok: true, sent: results.filter((r) => r.ok).length })
    }

    // ring
    const staffIds = Array.isArray(body.staffIds) ? body.staffIds.map(String).filter(Boolean) : []
    const token = String(body.token ?? '').trim()
    if (!staffIds.length || !token || !mediaWsUrl) {
      return NextResponse.json({ ok: true, sent: 0, note: 'nothing to ring' })
    }
    const targets = await getCallPushTargets(staffIds)
    if (!targets.voip.length) return NextResponse.json({ ok: true, sent: 0 })

    const display = await callerRingDisplay(String(body.caller ?? ''))
    const results = await sendVoipCall(targets.voip, {
      type: 'sip_call',
      broadcastId: callId,
      channel: `sip_${callId}`,
      caller: display,
      event: 'ring',
      schemaVersion: 1,
      expiresAt: body.expiresAt,
      mediaToken: token,
      mediaWsUrl,
    })
    return NextResponse.json({ ok: true, sent: results.filter((r) => r.ok).length })
  } catch (err) {
    return NextResponse.json({ ok: true, sent: 0, error: err instanceof Error ? err.message : String(err) })
  }
}
