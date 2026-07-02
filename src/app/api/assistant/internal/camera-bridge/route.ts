/**
 * Camera bridge endpoint — polled by the OFFICE PC, not by a browser session.
 *
 * Contract for the office-PC poller (small script next to go2rtc):
 *   • Every few seconds:  GET /api/assistant/internal/camera-bridge
 *       Authorization: Bearer <token>       (KV 'camera_bridge_token')
 *       → { job: null }                     nothing to play
 *       → { job: { id, stream, text, audioUrl } }
 *         Download audioUrl (signed MP3, ~10 min validity) and play it into
 *         the go2rtc stream named `stream` (camera two-way-audio backchannel).
 *   • After playback:     POST /api/assistant/internal/camera-bridge
 *       body { id, ok, error? } → { ok: true }
 *
 * Auth is a shared bearer token (NOT the owner session — the office PC has no
 * cookies). Token lives in agent_kv_settings so the owner can rotate it
 * without a redeploy; comparison is timing-safe. Claiming marks the job
 * 'delivered', and stale queued jobs expire server-side, so a bridge that was
 * offline for hours never blares old announcements on reconnect.
 */
import { timingSafeEqual } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { claimNextSpeakJob, ackSpeakJob, getBridgeToken } from '@/agent/lib/camera-say'

export const runtime = 'nodejs'
export const maxDuration = 30

async function bridgeAuthorized(req: NextRequest): Promise<boolean> {
  const header = req.headers.get('authorization') ?? ''
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!presented) return false
  const expected = await getBridgeToken()
  if (!expected) return false
  try {
    return timingSafeEqual(Buffer.from(presented), Buffer.from(expected))
  } catch {
    // timingSafeEqual throws on length mismatch → simply not a match.
    return false
  }
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  if (!(await bridgeAuthorized(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const job = await claimNextSpeakJob()
  return NextResponse.json({ job })
}

interface AckBody {
  id?: string
  ok?: boolean
  error?: string
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  if (!(await bridgeAuthorized(req))) {
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

  await ackSpeakJob(body.id, body.ok !== false, body.error)
  return NextResponse.json({ ok: true })
}
