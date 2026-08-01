/**
 * L7 — the owner's start/stop for live screen streaming, from the dock.
 *
 * Owner-session only (cookie auth, like live-activity and session-reply).
 * The gate IS this explicit tap: the daemon never starts a capture loop on
 * its own, the loop self-stops at its deadline, and the kill-switch stops it
 * mid-flight. A capture loop is read-only on the Mac — green by construction,
 * gated by consent rather than the classifier.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { activeDevice, enqueueCommand, isMacAgentEnabled } from '@/agent/lib/mac-agent/bus'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const owner = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!owner?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(owner)) return Response.json({ error: 'forbidden' }, { status: 403 })

  let body: { on?: boolean; maxSeconds?: number }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  if (!(await isMacAgentEnabled())) {
    return Response.json({ error: 'mac_agent_disabled', messageBn: 'Mac control বন্ধ আছে।' }, { status: 409 })
  }
  const device = await activeDevice()
  if (!device) {
    return Response.json({ error: 'mac_offline', messageBn: 'আপনার Mac এখন অফলাইন।' }, { status: 409 })
  }

  const { id } = await enqueueCommand({
    deviceId: device.id,
    action: 'screen_stream',
    params: body.on === false
      ? { mode: 'stop' }
      : { mode: 'start', maxSeconds: Number(body.maxSeconds) || undefined },
  })
  return Response.json({ ok: true, commandId: id, on: body.on !== false })
}
