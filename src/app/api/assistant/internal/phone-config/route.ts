/**
 * GET /api/assistant/internal/phone-config — the settings the SIP gateway reads.
 *
 * THE POINT OF THE WHOLE STEP: half the phone settings are read on the VPS, not on Vercel —
 * ring rounds, ring timeouts, the concurrency cap, voicemail length, the hold-music class,
 * and the gateway's own pre-answer blocklist. Until now every one of them was an env var
 * behind SSH, so "change settings without SSH" would have been half true.
 *
 * The gateway PULLS this once a minute rather than us pushing: a pull cannot leave the box
 * in a state we did not verify, it re-syncs by itself after a restart or a network blip, and
 * it needs no inbound port. On any failure the gateway keeps its previous values and falls
 * back to its env, so this endpoint being down changes nothing about how calls behave.
 *
 * NOT here, and never will be: the call-audio tuning. Those values are code defaults in git
 * with deliberately no remote override, so the voice the owner approved cannot be altered by
 * anything reachable over the network. See CLAUDE.md hard rule #1.
 *
 * Auth: the shared `AGENT_INTERNAL_TOKEN`. Lives under `/api/assistant/internal/` because
 * middleware already exempts that whole prefix from the session check — a new voice route
 * that needs its own exemption 401s until someone remembers to add it (trap #8).
 */
import { type NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { gatewayConfigPayload, markGatewayPull } from '@/agent/lib/phone-settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function tokenOk(req: NextRequest): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected) return false
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  } catch {
    return false
  }
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  if (!tokenOk(req)) return NextResponse.json({ ok: false }, { status: 401 })

  const config = await gatewayConfigPayload()
  // Recorded so the settings screen can show that a gateway-scoped change actually LANDED,
  // rather than only that it was saved. Best-effort — never fails the pull.
  void markGatewayPull()

  return NextResponse.json({ ok: true, config })
}
