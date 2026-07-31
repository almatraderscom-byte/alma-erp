/**
 * M1 — daemon pairing. The Mac daemon POSTs the one-time code (the agent generated
 * it for the owner) and gets back a bearer token. Public endpoint, but useless
 * without a valid, unexpired, owner-issued code; the code is single-use and burns
 * on redemption.
 */
import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isMacAgentEnabled, redeemPairingCode } from '@/agent/lib/mac-agent/bus'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  if (!(await isMacAgentEnabled())) {
    return Response.json({ error: 'mac_agent_disabled' }, { status: 503 })
  }

  let body: { code?: string; deviceName?: string; meta?: Record<string, unknown> }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const res = await redeemPairingCode(String(body.code ?? ''), {
    deviceName: body.deviceName,
    meta: body.meta,
  })
  if (!res.ok) {
    const status = res.error === 'invalid_code' || res.error === 'code_expired' ? 401 : 400
    return Response.json({ error: res.error ?? 'pairing_failed' }, { status })
  }

  return Response.json({ token: res.token, deviceId: res.deviceId })
}
