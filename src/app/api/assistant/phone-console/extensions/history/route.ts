/**
 * GET /api/assistant/phone-console/extensions/history?ext=1001 — one person's recent calls.
 *
 * These come from ASTERISK'S own call log on the VPS, not from our database, because a staff
 * member's calls never pass through the gateway: their browser registers straight to Asterisk
 * and the dialplan dials out. When that log is not available the screen says so — a silent
 * empty list would read as "this person has made no calls", which is a different claim.
 *
 * Recordings are NOT here. We record the AI's bridge, not staff-to-customer calls, so there
 * is nothing to play. Saying that plainly is better than an empty player.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { requireConsoleOwner } from '@/agent/lib/phone-console-guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const gate = await requireConsoleOwner()
  if (!gate.ok) return gate.response

  const ext = (new URL(req.url).searchParams.get('ext') ?? '').replace(/\D/g, '')
  if (!ext) return NextResponse.json({ ok: false, error: 'কোন এক্সটেনশন সেটা বলা হয়নি।' }, { status: 400 })

  const base = (process.env.SIP_GATEWAY_BASE ?? '').replace(/\/$/, '')
  const token = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!base || !token) return NextResponse.json({ ok: true, rows: [], error: 'গেটওয়ের ঠিকানা সেট করা নেই।' })

  try {
    const res = await fetch(`${base}/api/v1/webrtc/history?ext=${ext}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    })
    const body = (await res.json()) as { rows?: unknown[]; error?: string }
    if (!res.ok) return NextResponse.json({ ok: true, rows: [], error: body.error ?? `HTTP ${res.status}` })
    return NextResponse.json({ ok: true, rows: body.rows ?? [], error: body.error ?? null })
  } catch (err) {
    return NextResponse.json({ ok: true, rows: [], error: err instanceof Error ? err.message : String(err) })
  }
}
