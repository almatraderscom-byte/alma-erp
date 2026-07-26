/**
 * POST /api/assistant/phone-console/routing/preview — "a call from 01712345678 at 21:30
 * would reach …", answered by the code that actually decides it.
 *
 * This is the most important route in step 4 and the reason the rules were moved out of the
 * inbound handler: it calls `decideInbound()` and `applyOutboundRules()`, the same functions
 * the live call path calls. Nothing here re-derives a rule. A preview that re-implements the
 * routing is a second set of routing, and the day the two disagree the screen becomes the
 * most confident liar in the system — about the one thing whose bugs stay invisible until a
 * customer hits them.
 *
 * Owner-only, and it places no call and writes nothing: it evaluates and reports.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { requireConsoleOwner } from '@/agent/lib/phone-console-guard'
import { isOwnerNumber } from '@/agent/lib/voice-call'
import { applyOutboundRules, gatewayConfigPayload } from '@/agent/lib/phone-settings'
import { decideInbound, dhakaParts, readDidRoutes, readInboundSettings } from '@/agent/lib/phone-routing'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const gate = await requireConsoleOwner()
  if (!gate.ok) return gate.response

  const body = (await req.json().catch(() => ({}))) as {
    caller?: string
    did?: string
    at?: string
    date?: string
    outboundTo?: string
  }

  const caller = String(body.caller ?? '').trim()
  const did = String(body.did ?? '').trim()
  const time = /^\d{1,2}:\d{2}$/.test(String(body.at ?? '')) ? String(body.at) : '12:00'
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date ?? ''))
    ? String(body.date)
    : dhakaParts(new Date()).ymd

  // The screen gives a Dhaka wall clock; Bangladesh is UTC+6 with no daylight saving, so the
  // instant is exact arithmetic rather than a timezone guess.
  const [hh, mm] = time.split(':').map(Number)
  const at = new Date(Date.parse(`${date}T00:00:00Z`) + (hh - 6) * 3_600_000 + mm * 60_000)
  if (Number.isNaN(at.getTime())) {
    return NextResponse.json({ ok: false, error: 'তারিখ বা সময়টা পড়া গেল না।' }, { status: 400 })
  }

  const [settings, routes, gwConfig] = await Promise.all([
    readInboundSettings(),
    readDidRoutes(),
    gatewayConfigPayload(),
  ])

  const inbound = decideInbound({
    caller,
    did,
    at,
    owner: Boolean(caller) && isOwnerNumber(caller),
    settings,
    routes,
  })

  const outboundTo = String(body.outboundTo ?? '').trim()
  const outbound = outboundTo ? applyOutboundRules(outboundTo, gwConfig) : null

  return NextResponse.json({
    ok: true,
    inbound,
    outbound,
    // Echoed back so the screen can show exactly which instant was evaluated — a preview of
    // "now" that silently used a different clock would be its own kind of lie.
    evaluatedAt: { ...dhakaParts(at), iso: at.toISOString() },
  })
}
