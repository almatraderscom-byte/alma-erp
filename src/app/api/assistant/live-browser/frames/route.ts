/** Device-authenticated latest-frame ingest for the live Browser preview. */
import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import {
  authenticateDevice,
  getActiveBrowserPreviewLease,
  isLiveBrowserEnabled,
  storeBrowserPreviewFrame,
} from '@/agent/lib/live-browser/companion'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_FRAME_CHARS = 3_500_000
const MAX_CONTEXT_CHARS = 160
const MAX_FRAME_AGE_MS = 2 * 60_000
const MAX_FUTURE_SKEW_MS = 5_000

function bearer(req: NextRequest): string {
  const header = req.headers.get('authorization') ?? ''
  return header.startsWith('Bearer ') ? header.slice(7).trim() : ''
}

export function parseBrowserFrame(input: unknown, now = Date.now()): {
  ok: true
  dataUri: string
  contextId: string
  capturedAt: Date
  turnId: string
  conversationId: string
} | { ok: false; error: string } {
  const body = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const dataUri = typeof body.dataUri === 'string' ? body.dataUri : ''
  if (!/^data:image\/(?:jpeg|png);base64,/i.test(dataUri) || dataUri.length > MAX_FRAME_CHARS) {
    return { ok: false, error: 'invalid_frame' }
  }
  const contextId = typeof body.contextId === 'string' ? body.contextId.trim() : ''
  if (!contextId || contextId.length > MAX_CONTEXT_CHARS || !/^tab:[1-9]\d{0,9}$/.test(contextId)) {
    return { ok: false, error: 'invalid_context' }
  }
  const capturedAt = new Date(typeof body.capturedAt === 'string' ? body.capturedAt : '')
  const time = capturedAt.getTime()
  if (!Number.isFinite(time) || time < now - MAX_FRAME_AGE_MS || time > now + MAX_FUTURE_SKEW_MS) {
    return { ok: false, error: 'invalid_capture_time' }
  }
  const turnId = typeof body.turnId === 'string' ? body.turnId.trim() : ''
  const conversationId = typeof body.conversationId === 'string' ? body.conversationId.trim() : ''
  if (!turnId || !conversationId || turnId.length > 200 || conversationId.length > 200) {
    return { ok: false, error: 'invalid_activity_identity' }
  }
  return { ok: true, dataUri, contextId, capturedAt, turnId, conversationId }
}

export function frameMatchesLease(
  frame: { turnId: string; conversationId: string },
  lease: { turnId: string; conversationId: string },
): boolean {
  return frame.turnId === lease.turnId && frame.conversationId === lease.conversationId
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const device = await authenticateDevice(bearer(req), {
    allowRevocationPending: true,
  })
  if (!device) return Response.json({ error: 'unauthorized' }, { status: 401 })
  const enabled = await isLiveBrowserEnabled()

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const parsed = parseBrowserFrame(raw)
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 })

  // Global OFF blocks all ordinary capture, but an effect that won final
  // authorization before STOP must remain witnessed until its exact outcome.
  const lease = await getActiveBrowserPreviewLease(device.id, {
    requireExecuting: !enabled || device.revocationPending,
  })
  if (!lease) {
    return Response.json({
      error: enabled ? 'preview_lease_inactive' : 'live_browser_disabled',
    }, { status: 409 })
  }
  if (!frameMatchesLease(parsed, lease)) {
    return Response.json({ error: 'preview_lease_changed' }, { status: 409 })
  }
  const stored = await storeBrowserPreviewFrame({
    deviceId: device.id,
    contextId: parsed.contextId,
    dataUri: parsed.dataUri,
    capturedAt: parsed.capturedAt,
    lease,
  })
  return Response.json({
    ok: true,
    accepted: stored.accepted,
    frameAt: stored.frameAt.toISOString(),
    frameSeq: stored.frameSeq,
    contextId: parsed.contextId,
    turnId: lease.turnId,
    conversationId: lease.conversationId,
    // Carries a native 10s renewal back into an extension that is busy inside
    // one long command and therefore cannot poll for a refreshed grant.
    leaseExpiresAt: lease.expiresAt.toISOString(),
  }, { headers: { 'Cache-Control': 'private, no-store' } })
}
