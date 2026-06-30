/**
 * Phase E — extension pairing. The owner's Chrome extension POSTs the one-time code
 * (the agent generated it for him) and gets back a bearer token. Public endpoint,
 * but useless without a valid, unexpired, owner-issued code; the code is single-use.
 */
import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isLiveBrowserEnabled, redeemPairingCode } from '@/agent/lib/live-browser/companion'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  if (!(await isLiveBrowserEnabled())) {
    return Response.json({ error: 'live_browser_disabled' }, { status: 503 })
  }

  let body: { code?: string; deviceName?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const res = await redeemPairingCode(String(body.code ?? ''), body.deviceName)
  if (!res.ok) {
    const status = res.error === 'invalid_code' || res.error === 'code_expired' ? 401 : 400
    return Response.json({ error: res.error ?? 'pairing_failed' }, { status })
  }

  return Response.json({ token: res.token, deviceId: res.deviceId })
}
