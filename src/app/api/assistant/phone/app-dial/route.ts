/**
 * POST /api/assistant/phone/app-dial — native iOS outbound call (phone program step 3).
 *
 * The app's native dialler asks for a call here; the gateway mints the call and a
 * one-time media token; the app then opens wss://<gateway>/app-media?token=… and the
 * gateway originates the customer leg — so the customer's phone only rings once the
 * staff member's audio path already exists. The staff identity comes from the SESSION,
 * never from the client, and the gateway re-applies the same per-extension outbound
 * policy a hand-dialled call obeys.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { normalizeAlmaRole } from '@/lib/roles'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  const user = session?.user as { id?: string; name?: string | null; email?: string | null } | undefined
  if (!user?.id) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 })
  // VIEWER is read-only by definition — a phone identity that can place real
  // calls must never be minted for it (Codex P1, PR #868).
  const role = normalizeAlmaRole((session?.user as { role?: string } | undefined)?.role)
  if (role === 'VIEWER') return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 })

  const base = (process.env.SIP_GATEWAY_BASE ?? '').replace(/\/$/, '')
  const token = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!base || !token) return NextResponse.json({ ok: false, error: 'phone_not_configured' }, { status: 503 })

  const body = (await req.json().catch(() => ({}))) as { to?: string }
  const to = String(body.to ?? '').replace(/\D/g, '')
  if (!to) return NextResponse.json({ ok: false, error: 'missing number' }, { status: 400 })

  try {
    // Dial FIRST — an existing extension (the normal case, every call after the
    // first) must not pay a provision round-trip: it was ~1.5 s of the owner's
    // "call screen ashe 3/5 sec por" complaint. Provision only on the 404 a
    // first-ever caller gets, then retry once.
    const dial = () => fetch(`${base}/api/v1/app-dial`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ staffId: user.id, to }),
      signal: AbortSignal.timeout(20_000),
    })
    let res = await dial()
    if (res.status === 404) {
      await fetch(`${base}/api/v1/webrtc/provision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ staffId: user.id, name: user.name ?? user.email ?? '' }),
        signal: AbortSignal.timeout(20_000),
      })
      res = await dial()
    }
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean; callId?: string; token?: string; error?: string
    }
    if (!res.ok || !data.ok || !data.callId || !data.token) {
      return NextResponse.json({ ok: false, error: data.error ?? 'dial_failed' }, { status: 502 })
    }
    const wsUrl = `${base.replace(/^https?:/, base.startsWith('https') ? 'wss:' : 'ws:')}/app-media`
    return NextResponse.json({ ok: true, callId: data.callId, token: data.token, wsUrl })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    )
  }
}
