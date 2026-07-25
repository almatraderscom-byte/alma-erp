/**
 * GET  /api/assistant/phone-console/settings — every phone setting + where its value comes from
 * PATCH same — change exactly one setting
 *
 * Owner-only. One key per PATCH on purpose: a form that saves eight values at once produces
 * an audit row nobody can read back, and on a live line "what did I just change" has to have
 * a one-line answer.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { requireConsoleOwner } from '@/agent/lib/phone-console-guard'
import { fetchLine } from '@/agent/lib/phone-console'
import { lastGatewayPull, readSettings, writeSetting } from '@/agent/lib/phone-settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const gate = await requireConsoleOwner()
  if (!gate.ok) return gate.response

  // The gateway's reachability is shown beside gateway-scoped settings, so a value that
  // cannot land yet says so instead of looking saved-and-live.
  const [settings, gatewayPulledAt, line] = await Promise.all([
    readSettings(),
    lastGatewayPull(),
    fetchLine().catch(() => null),
  ])

  return NextResponse.json({
    ok: true,
    settings,
    gatewayPulledAt,
    gatewayReachable: Boolean(line?.reachable),
  })
}

export async function PATCH(req: NextRequest) {
  const gate = await requireConsoleOwner()
  if (!gate.ok) return gate.response

  const body = (await req.json().catch(() => ({}))) as { key?: string; value?: string }
  const key = String(body.key ?? '').trim()
  if (!key) return NextResponse.json({ ok: false, error: 'কোন সেটিং বদলাবেন সেটা বলা হয়নি।' }, { status: 400 })

  const result = await writeSetting(key, String(body.value ?? ''), gate.actor)
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 400 })

  return NextResponse.json({
    ok: true,
    value: result.value,
    warning: result.warning,
    // An app-scoped change applies to the very next call; a gateway-scoped one waits for the
    // VPS to pull it. Saying which is the difference between a screen you trust and one you
    // re-check over SSH.
    applies: result.scope === 'app' ? 'next_call' : 'gateway_pull',
  })
}
