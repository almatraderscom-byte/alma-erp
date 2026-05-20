import { NextRequest } from 'next/server'
import { resolveBusinessId, type BusinessId } from '@/lib/businesses'
import { prisma } from '@/lib/prisma'
import { parseQueueMetadata } from '@/lib/telegram-notification/deliver'
import { getTelegramOpsSetting, telegramOpsSettingDto, upsertTelegramOpsSetting } from '@/lib/telegram-notification/settings'
import { resolveProfileImageForUser } from '@/lib/user-display'
import { withApiRoute, apiDataSuccess, requireJwtRoles, parseJsonBody } from '@/lib/core/safe-route-helpers'

export const GET = withApiRoute('telegram.ops.queue', async (req: NextRequest) => {
  const auth = await requireJwtRoles(req, ['SUPER_ADMIN', 'ADMIN'])
  if (!auth.ok) return auth.response

  const businessId = resolveBusinessId(req.nextUrl.searchParams.get('business_id'))
  const setting = await getTelegramOpsSetting(businessId)

  const recentQueue = await prisma.telegramNotificationQueue.findMany({
    where: { businessId },
    orderBy: { createdAt: 'desc' },
    take: 30,
    select: {
      id: true,
      eventType: true,
      status: true,
      chatId: true,
      attempts: true,
      errorMessage: true,
      sentAt: true,
      createdAt: true,
      metadataJson: true,
    },
  })

  const userIds = [
    ...new Set(
      recentQueue
        .map(r => parseQueueMetadata(r.metadataJson).userId)
        .filter((id): id is string => Boolean(id)),
    ),
  ]
  const users = userIds.length
    ? await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, profileImageUrl: true, updatedAt: true },
      })
    : []
  const userMap = new Map(users.map(u => [u.id, u]))

  const stats = await prisma.telegramNotificationQueue.groupBy({
    by: ['status'],
    where: { businessId, createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
    _count: { _all: true },
  })

  return apiDataSuccess({
    setting: telegramOpsSettingDto(setting),
    recentQueue: recentQueue.map(r => {
      const meta = parseQueueMetadata(r.metadataJson)
      const user = meta.userId ? userMap.get(meta.userId) : null
      return {
        ...r,
        createdAt: r.createdAt.toISOString(),
        sentAt: r.sentAt?.toISOString() ?? null,
        employeeName: meta.employeeName || user?.name || null,
        profileImageUrl: user ? resolveProfileImageForUser(user) : null,
        userId: meta.userId || null,
      }
    }),
    stats: stats.map(s => ({ status: s.status, count: s._count._all })),
  })
})

export const PATCH = withApiRoute('telegram.ops.settings', async (req: NextRequest) => {
  const auth = await requireJwtRoles(req, ['SUPER_ADMIN', 'ADMIN'])
  if (!auth.ok) return auth.response

  const body = await parseJsonBody<Record<string, unknown>>(req)
  const businessId = resolveBusinessId(String(body.business_id || ''))

  const patch: Partial<ReturnType<typeof telegramOpsSettingDto>> & { updatedById?: string } = {
    updatedById: String(auth.token.sub),
  }
  const boolKeys = [
    'enabled',
    'alertAttendanceCheckIn',
    'alertAttendanceLate',
    'alertAttendanceAbsent',
    'alertAttendanceCheckOut',
    'alertAttendanceNoCheckout',
    'alertAttendanceEarlyLeave',
    'alertAttendanceSuspicious',
    'alertTradingScreenshot',
    'alertTradingDeleteRequest',
    'alertOpsDailySummary',
  ] as const
  const intKeys = [
    'officeStartMinutes',
    'gracePeriodMinutes',
    'checkoutCutoffMinutes',
    'earlyLeaveMinutes',
  ] as const

  for (const k of boolKeys) {
    if (typeof body[k] === 'boolean') (patch as Record<string, boolean>)[k] = body[k] as boolean
  }
  for (const k of intKeys) {
    if (body[k] != null && Number.isFinite(Number(body[k]))) {
      patch[k] = Math.floor(Number(body[k]))
    }
  }
  if (typeof body.ownerChatIds === 'string') patch.ownerChatIds = body.ownerChatIds.trim().slice(0, 2000)

  const setting = await upsertTelegramOpsSetting(businessId as BusinessId, patch)
  return apiDataSuccess({ setting })
})
