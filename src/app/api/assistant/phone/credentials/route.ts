/**
 * GET /api/assistant/phone/credentials — SIP identity for the browser softphone.
 *
 * Self-hosting the PBX means staff can take real customer calls inside the ERP: no SIM, no
 * handset, no per-seat fee — and the browser already knows which customer the call is about.
 *
 * The browser must authenticate to Asterisk itself, so it genuinely needs a SIP password.
 * That password is generated and kept on the VPS (a 0600 file next to the gateway), never in
 * this application's database; this route asks the gateway for it and hands it to ONE
 * logged-in session over HTTPS. Losing the ERP database therefore does not leak the phone
 * system, and the dialplan the extension lands in only permits internal extensions and
 * Bangladeshi numbers, so a stolen credential cannot be turned into international toll fraud.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest) {
  const session = await getServerSession(authOptions)
  const user = session?.user as { id?: string; name?: string | null; email?: string | null } | undefined
  if (!user?.id) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 })

  const base = (process.env.SIP_GATEWAY_BASE ?? '').replace(/\/$/, '')
  const token = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!base || !token) {
    return NextResponse.json({ ok: false, error: 'phone_not_configured' }, { status: 503 })
  }

  try {
    const res = await fetch(`${base}/api/v1/webrtc/provision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ staffId: user.id, name: user.name ?? user.email ?? '' }),
      signal: AbortSignal.timeout(20_000),
    })
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean; extension?: string; password?: string; realm?: string; error?: string
    }
    if (!res.ok || !data.ok || !data.extension) {
      return NextResponse.json({ ok: false, error: data.error ?? 'provision_failed' }, { status: 502 })
    }
    // The websocket lives behind the same TLS host as the gateway; only /ws is proxied
    // through, so Asterisk's ARI is never reachable from a browser.
    const wsUrl = `${base.replace(/^https?:/, base.startsWith('https') ? 'wss:' : 'ws:')}/ws`
    return NextResponse.json({
      ok: true,
      extension: data.extension,
      password: data.password,
      realm: data.realm,
      wsUrl,
      displayName: user.name ?? '',
    })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    )
  }
}
