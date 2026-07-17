import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import {
  OFFICE_CALL_PRODUCT_CONTRACT,
  OFFICE_CALL_TIMING,
  isOfficeCallId,
} from '@/agent/lib/office-call-observability'
import { apnsVoipConfigured } from '@/agent/lib/apns-voip'
import { fcmCallConfigured } from '@/agent/lib/fcm-call'
import { getBuildInfo } from '@/lib/runtime-build'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DEFAULT_BUSINESS = 'ALMA_LIFESTYLE'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'owner_only' }, { status: 403 })

  const businessId = req.nextUrl.searchParams.get('businessId')?.trim() || DEFAULT_BUSINESS
  const callId = req.nextUrl.searchParams.get('callId')?.trim() || null
  if (callId && !isOfficeCallId(callId)) {
    return Response.json({ error: 'invalid_call_id' }, { status: 400 })
  }

  const [registered, events, call] = await Promise.all([
    prisma.pushSubscription.groupBy({
      by: ['provider', 'platform'],
      where: {
        enabled: true,
        OR: [{ businessId }, { businessId: null }],
        provider: { in: ['apns_voip', 'fcm', 'onesignal'] },
      },
      _count: { id: true },
    }),
    prisma.officeCallEvent.findMany({
      where: { businessId, ...(callId ? { callId } : {}) },
      orderBy: { occurredAt: 'desc' },
      take: callId ? 200 : 50,
      select: {
        id: true,
        callId: true,
        source: true,
        platform: true,
        appBuild: true,
        buildSha: true,
        event: true,
        state: true,
        provider: true,
        success: true,
        latencyMs: true,
        metadata: true,
        occurredAt: true,
      },
    }),
    callId
      ? prisma.officeIntercomBroadcast.findFirst({
          where: { id: callId, businessId, kind: 'call' },
          select: {
            id: true,
            senderUserId: true,
            targetUserId: true,
            targetStaffId: true,
            callerName: true,
            createdAt: true,
            endedAt: true,
            endedReason: true,
          },
        })
      : Promise.resolve(null),
  ])

  return Response.json({
    ok: true,
    build: getBuildInfo(),
    configuration: {
      agora: Boolean(process.env.AGORA_APP_ID?.trim() && process.env.AGORA_APP_CERTIFICATE?.trim()),
      apnsVoip: apnsVoipConfigured(),
      fcm: fcmCallConfigured(),
      oneSignal: Boolean(
        (process.env.ONESIGNAL_APP_ID || process.env.NEXT_PUBLIC_ONESIGNAL_APP_ID) &&
          process.env.ONESIGNAL_REST_API_KEY,
      ),
    },
    timing: OFFICE_CALL_TIMING,
    contract: OFFICE_CALL_PRODUCT_CONTRACT,
    registeredDevices: registered.map((row) => ({
      provider: row.provider,
      platform: row.platform,
      count: row._count.id,
    })),
    call,
    events,
  })
}
