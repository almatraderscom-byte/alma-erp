import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { resolveSessionStaff } from '@/agent/lib/office-staff'
import {
  isOfficeCallClientEvent,
  isOfficeCallId,
  recordOfficeCallEvent,
  type OfficeCallPlatform,
} from '@/agent/lib/office-call-observability'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { getOfficeCallRuntimePolicy } from '@/agent/lib/office-call-reliability'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DEFAULT_BUSINESS = 'ALMA_LIFESTYLE'
const PLATFORMS = new Set<OfficeCallPlatform>(['web', 'ios', 'android'])

type Identity =
  | { ok: true; userId: string; businessId: string }
  | { ok: false; error: string; code: number }

async function identify(req: NextRequest): Promise<Identity> {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return { ok: false, error: 'unauthorized', code: 401 }
  if (isSystemOwner(token)) {
    return {
      ok: true,
      userId: token.sub,
      businessId: req.nextUrl.searchParams.get('businessId')?.trim() || DEFAULT_BUSINESS,
    }
  }
  const staff = await resolveSessionStaff(token.sub)
  return staff
    ? { ok: true, userId: token.sub, businessId: staff.businessId }
    : { ok: false, error: 'forbidden', code: 403 }
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const identity = await identify(req)
  if (!identity.ok) return Response.json({ error: identity.error }, { status: identity.code })

  const contentLength = Number(req.headers.get('content-length') ?? 0)
  if (contentLength > 16_384) return Response.json({ error: 'payload_too_large' }, { status: 413 })

  let body: {
    callId?: string
    event?: string
    platform?: string
    deviceId?: string
    appBuild?: string
    buildSha?: string
    state?: string
    latencyMs?: number
    metadata?: unknown
    occurredAt?: string
  }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const callId = body.callId?.trim() || ''
  const event = body.event?.trim() || ''
  const platform = body.platform?.trim() as OfficeCallPlatform
  if (!isOfficeCallId(callId)) return Response.json({ error: 'invalid_call_id' }, { status: 400 })
  if (!isOfficeCallClientEvent(event)) return Response.json({ error: 'invalid_event' }, { status: 400 })
  if (!PLATFORMS.has(platform)) return Response.json({ error: 'invalid_platform' }, { status: 400 })

  const participant = await prisma.officeIntercomBroadcast.findFirst({
    where: {
      id: callId,
      businessId: identity.businessId,
      kind: 'call',
      OR: [{ senderUserId: identity.userId }, { targetUserId: identity.userId }],
    },
    select: { id: true },
  })
  if (!participant) return Response.json({ error: 'call_forbidden' }, { status: 403 })

  const eventLimit = getOfficeCallRuntimePolicy().rateLimit.eventsPerCallPerMinute
  const recentEvents = await prisma.officeCallEvent.count({
    where: {
      callId,
      actorUserId: identity.userId,
      occurredAt: { gte: new Date(Date.now() - 60_000) },
    },
  })
  if (recentEvents >= eventLimit) {
    return Response.json(
      { error: 'rate_limited', retryAfterSec: 60 },
      { status: 429, headers: { 'Retry-After': '60' } },
    )
  }

  const occurredAt = body.occurredAt ? new Date(body.occurredAt) : undefined
  if (occurredAt && Number.isNaN(occurredAt.getTime())) {
    return Response.json({ error: 'invalid_occurred_at' }, { status: 400 })
  }
  if (occurredAt) {
    const skewMs = occurredAt.getTime() - Date.now()
    if (skewMs > 5 * 60_000 || skewMs < -24 * 60 * 60_000) {
      return Response.json({ error: 'occurred_at_out_of_range' }, { status: 400 })
    }
  }

  await recordOfficeCallEvent({
    callId,
    businessId: identity.businessId,
    actorUserId: identity.userId,
    source: platform,
    platform,
    event,
    deviceId: body.deviceId,
    appBuild: body.appBuild,
    buildSha: body.buildSha,
    state: body.state,
    latencyMs: body.latencyMs,
    metadata: body.metadata,
    occurredAt,
  })

  return Response.json({ ok: true }, { status: 202 })
}
