/**
 * POST /api/assistant/phone/dial — click-to-call from anywhere in the ERP.
 *
 * Staff click a customer; their own browser phone rings; when they pick up, the customer is
 * dialled and bridged. Ringing the staff member FIRST is deliberate — the other order makes
 * the customer answer to silence while we chase whoever clicked.
 *
 * GET returns the colleague directory, so staff-to-staff calling does not require anyone to
 * memorise extension numbers.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function gateway(): { base: string; token: string } | null {
  const base = (process.env.SIP_GATEWAY_BASE ?? '').replace(/\/$/, '')
  const token = process.env.AGENT_INTERNAL_TOKEN ?? ''
  return base && token ? { base, token } : null
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  const user = session?.user as { id?: string; name?: string | null; email?: string | null } | undefined
  if (!user?.id) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 })

  const gw = gateway()
  if (!gw) return NextResponse.json({ ok: false, error: 'phone_not_configured' }, { status: 503 })

  const body = (await req.json().catch(() => ({}))) as { to?: string }
  const to = String(body.to ?? '').replace(/\D/g, '')
  if (!to) return NextResponse.json({ ok: false, error: 'missing number' }, { status: 400 })

  try {
    // Resolve (or create) this staff member's own extension — never trust one from the client.
    const prov = await fetch(`${gw.base}/api/v1/webrtc/provision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gw.token}` },
      body: JSON.stringify({ staffId: user.id, name: user.name ?? user.email ?? '' }),
      signal: AbortSignal.timeout(20_000),
    })
    const cred = (await prov.json().catch(() => ({}))) as { extension?: string }
    if (!cred.extension) return NextResponse.json({ ok: false, error: 'no_extension' }, { status: 502 })

    const res = await fetch(`${gw.base}/api/v1/click2call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gw.token}` },
      body: JSON.stringify({ ext: cred.extension, to }),
      signal: AbortSignal.timeout(25_000),
    })
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
    if (!res.ok || !data.ok) {
      return NextResponse.json({ ok: false, error: data.error ?? 'dial_failed' }, { status: 502 })
    }
    return NextResponse.json({ ok: true, from: cred.extension, to })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    )
  }
}

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 })
  const gw = gateway()
  if (!gw) return NextResponse.json({ ok: true, staff: [] })
  try {
    const res = await fetch(`${gw.base}/api/v1/webrtc/list`, {
      headers: { Authorization: `Bearer ${gw.token}` },
      signal: AbortSignal.timeout(15_000),
    })
    const data = (await res.json().catch(() => ({}))) as { staff?: Array<{ ext: string; name: string }> }
    return NextResponse.json({ ok: true, staff: data.staff ?? [] })
  } catch {
    return NextResponse.json({ ok: true, staff: [] })
  }
}
