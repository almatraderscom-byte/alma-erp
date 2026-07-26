/**
 * GET /api/assistant/phone/history — MY recent calls, for the dialler page.
 *
 * The phone page had no history at all: after a call there was no way to see who you had just
 * spoken to, for how long, or which number it was. Every mobile phone has this; a phone inside
 * an ERP should not be worse than the handset it replaces.
 *
 * Deliberately narrow. It returns only the SIGNED-IN staff member's own extension — the
 * extension is looked up from their session, never taken from the query string, so one staff
 * member cannot read another's calls by editing a URL. Anything richer (recordings,
 * transcripts, other people's calls) stays in the owner's console, which is where the
 * permissions for it live.
 *
 * The data is Asterisk's own call log on the VPS, because a staff call never passes through
 * the gateway: the browser registers straight to Asterisk and the dialplan dials out.
 */
import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { requireAgentEnabled } from '@/agent/lib/guards'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const session = await getServerSession(authOptions)
  const user = session?.user as { id?: string } | undefined
  if (!user?.id) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 })

  const base = (process.env.SIP_GATEWAY_BASE ?? '').replace(/\/$/, '')
  const token = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!base || !token) return NextResponse.json({ ok: true, rows: [], error: null })

  const headers = { Authorization: `Bearer ${token}` }
  try {
    // Which extension is theirs? Ask the gateway rather than trusting the browser.
    const listRes = await fetch(`${base}/api/v1/webrtc/list`, { headers, cache: 'no-store', signal: AbortSignal.timeout(15_000) })
    const list = (await listRes.json()) as { staff?: Array<{ staffId: string; ext: string }> }
    const mine = (list.staff ?? []).find((s) => s.staffId === user.id)
    if (!mine) return NextResponse.json({ ok: true, rows: [], error: null })

    const res = await fetch(`${base}/api/v1/webrtc/history?ext=${encodeURIComponent(mine.ext)}`, {
      headers, cache: 'no-store', signal: AbortSignal.timeout(20_000),
    })
    const body = (await res.json()) as { rows?: unknown[]; error?: string }
    return NextResponse.json({ ok: true, rows: (body.rows ?? []).slice(0, 20), error: body.error ?? null })
  } catch (err) {
    return NextResponse.json({ ok: true, rows: [], error: err instanceof Error ? err.message : String(err) })
  }
}
