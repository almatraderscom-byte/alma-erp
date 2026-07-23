import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getWalletContext } from '@/lib/payroll-wallet-access'
import {
  DEFAULT_NOTIFICATION_PREFERENCE,
  getNotificationPreference,
  NOTIFICATION_PREFERENCE_KEYS,
  type NotificationPreferenceSnapshot,
} from '@/lib/notification-preferences'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const ctx = await getWalletContext(req)
  if ('error' in ctx) return ctx.error
  return NextResponse.json({
    ok: true,
    role: ctx.role,
    preference: await getNotificationPreference(ctx.userId),
  })
}

export async function PATCH(req: NextRequest) {
  const ctx = await getWalletContext(req)
  if ('error' in ctx) return ctx.error

  const body = (await req.json().catch(() => null)) as Partial<NotificationPreferenceSnapshot> | null
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const update: Partial<NotificationPreferenceSnapshot> = {}
  for (const key of NOTIFICATION_PREFERENCE_KEYS) {
    if (!(key in body)) continue
    if (typeof body[key] !== 'boolean') {
      return NextResponse.json({ error: `${key} must be boolean` }, { status: 400 })
    }
    update[key] = body[key]
  }
  if (!Object.keys(update).length) {
    return NextResponse.json({ error: 'no preference fields supplied' }, { status: 400 })
  }

  const row = await prisma.notificationPreference.upsert({
    where: { userId: ctx.userId },
    update,
    create: {
      userId: ctx.userId,
      ...DEFAULT_NOTIFICATION_PREFERENCE,
      ...update,
    },
  })
  return NextResponse.json({
    ok: true,
    role: ctx.role,
    preference: Object.fromEntries(
      NOTIFICATION_PREFERENCE_KEYS.map(key => [key, row[key]]),
    ),
  })
}
