/**
 * Camera bridge endpoint — polled by the OFFICE PC, not by a browser session.
 *
 * Contract for the office-PC poller (small script next to go2rtc):
 *   • Every few seconds:  GET /api/assistant/internal/camera-bridge
 *       Authorization: Bearer <token>       (KV 'camera_bridge_token')
 *       → { job: null }                     nothing to play
 *       → { job: { id, stream, text, audioUrl, leaseToken, leaseExpiresAt } }
 *         Download audioUrl (signed MP3, ~10 min validity) and play it into
 *         the go2rtc stream named `stream` (camera two-way-audio backchannel).
 *   • After playback:     POST /api/assistant/internal/camera-bridge
 *       body { id, ok, error?, leaseToken? } → { ok: true, accepted: true }
 *
 * Auth is a shared bearer token (NOT the owner session — the office PC has no
 * cookies). Token lives in agent_kv_settings so the owner can rotate it
 * without a redeploy; comparison is timing-safe. Claiming marks the job
 * 'delivered', and stale queued jobs expire server-side, so a bridge that was
 * offline for hours never blares old announcements on reconnect.
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { claimNextSpeakJob, ackSpeakJob, sweepAndNotifySpeakJobs } from '@/agent/lib/camera-say'
import { cameraRequestAuthorized } from '@/agent/lib/camera-auth'
import { recordCameraHeartbeat } from '@/agent/lib/camera-health'

export const runtime = 'nodejs'
export const maxDuration = 30

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const auth = await cameraRequestAuthorized(req.headers, 'bridge')
  if (!auth.ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await recordCameraHeartbeat({ component: 'bridge' })
  const job = await claimNextSpeakJob()
  return NextResponse.json({ job })
}

interface AckBody {
  id?: string
  ok?: boolean
  error?: string
  leaseToken?: string
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const auth = await cameraRequestAuthorized(req.headers, 'bridge')
  if (!auth.ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: AckBody
  try {
    body = (await req.json()) as AckBody
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 })
  }
  if (!body.id || typeof body.id !== 'string') {
    return NextResponse.json({ error: 'id required' }, { status: 400 })
  }

  await recordCameraHeartbeat({ component: 'bridge' })
  const ack = await ackSpeakJob(body.id, body.ok !== false, body.error, body.leaseToken)
  if (!ack.accepted) {
    return NextResponse.json({ ok: false, ...ack }, { status: 409 })
  }
  // Outcome sweep right after the ack → the owner learns whether the playback
  // command was accepted, without falsely claiming a person heard the audio.
  await sweepAndNotifySpeakJobs()
  return NextResponse.json({ ok: true, ...ack })
}
