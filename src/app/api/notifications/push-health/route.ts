import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getJwt } from '@/lib/api-guards'
import { normalizeAlmaRole } from '@/lib/roles'
import { logEvent } from '@/lib/logger'

export const revalidate = 0

/**
 * Live push-delivery health, straight from OneSignal (2026-07-14 notification
 * audit). The DB's PushSubscription rows say a device REGISTERED once;
 * OneSignal says whether it can actually be reached NOW — staff phones sat
 * silent for weeks with "registered" rows whose OneSignal subscription was
 * dead (notification_types -10). This endpoint makes that visible.
 *
 * GET            → the caller's own devices (any authenticated user)
 * GET ?scope=all → every active user's summary (SUPER_ADMIN / ADMIN only)
 */

type DeviceState = {
  type: string
  enabled: boolean
  notificationTypes: number | null
  deviceModel: string | null
  deviceOs: string | null
}

type UserHealth = {
  userId: string
  name: string
  role: string
  devices: DeviceState[]
  enabledCount: number
  nativeEnabled: boolean
  verdict: 'OK' | 'WEB_ONLY' | 'DEAD' | 'NEVER_REGISTERED'
}

const NATIVE_TYPES = new Set(['iOSPush', 'AndroidPush'])

async function fetchOneSignalDevices(appId: string, apiKey: string, externalId: string): Promise<DeviceState[] | null> {
  const res = await fetch(
    `https://api.onesignal.com/apps/${appId}/users/by/external_id/${encodeURIComponent(externalId)}`,
    { headers: { Authorization: `Key ${apiKey}` }, cache: 'no-store' },
  )
  if (res.status === 404) return null
  if (!res.ok) {
    logEvent('warn', 'push_health.onesignal_fetch_failed', { status: res.status, externalId })
    return null
  }
  const body = (await res.json()) as {
    subscriptions?: Array<{
      type?: string
      enabled?: boolean
      notification_types?: number
      device_model?: string
      device_os?: string
    }>
  }
  return (body.subscriptions || [])
    .filter(sub => sub.type && sub.type !== 'Email' && sub.type !== 'SMS')
    .map(sub => ({
      type: sub.type || 'unknown',
      enabled: Boolean(sub.enabled),
      notificationTypes: typeof sub.notification_types === 'number' ? sub.notification_types : null,
      deviceModel: sub.device_model || null,
      deviceOs: sub.device_os || null,
    }))
}

function summarize(user: { id: string; name: string | null; role: string }, devices: DeviceState[] | null): UserHealth {
  const list = devices || []
  const enabled = list.filter(device => device.enabled)
  const nativeEnabled = enabled.some(device => NATIVE_TYPES.has(device.type))
  const verdict: UserHealth['verdict'] = devices === null || !list.length
    ? 'NEVER_REGISTERED'
    : !enabled.length
      ? 'DEAD'
      : nativeEnabled ? 'OK' : 'WEB_ONLY'
  return {
    userId: user.id,
    name: user.name || user.id,
    role: user.role,
    devices: list,
    enabledCount: enabled.length,
    nativeEnabled,
    verdict,
  }
}

export async function GET(req: NextRequest) {
  const token = await getJwt(req)
  if (!token?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const role = normalizeAlmaRole(token.role as string)

  const appId = process.env.ONESIGNAL_APP_ID || process.env.NEXT_PUBLIC_ONESIGNAL_APP_ID
  const apiKey = process.env.ONESIGNAL_REST_API_KEY
  if (!appId || !apiKey) return NextResponse.json({ configured: false, users: [] })

  const scope = new URL(req.url).searchParams.get('scope')
  if (scope === 'all') {
    if (!['SUPER_ADMIN', 'ADMIN'].includes(role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    const users = await prisma.user.findMany({
      where: { active: true },
      select: { id: true, name: true, role: true },
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
    })
    // Small team (single digits) — sequential fetches keep us far from
    // OneSignal rate limits and finish in ~1s.
    const results: UserHealth[] = []
    for (const user of users) {
      results.push(summarize(user, await fetchOneSignalDevices(appId, apiKey, user.id)))
    }
    return NextResponse.json({ configured: true, users: results })
  }

  const self = await prisma.user.findUnique({
    where: { id: token.sub },
    select: { id: true, name: true, role: true },
  })
  if (!self) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const health = summarize(self, await fetchOneSignalDevices(appId, apiKey, self.id))
  return NextResponse.json({ configured: true, users: [health] })
}
