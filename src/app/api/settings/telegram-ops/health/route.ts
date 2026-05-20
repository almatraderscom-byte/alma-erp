import { NextRequest, NextResponse } from 'next/server'
import { requireRoles } from '@/lib/api-guards'
import { resolveBusinessId } from '@/lib/businesses'
import { getTelegramBotToken, getTelegramWebhookInfo } from '@/lib/trading-telegram-bot'
import {
  getTelegramQueueHealth,
  processTelegramNotificationQueue,
  reclaimStuckTelegramSendingRows,
} from '@/lib/telegram-notification/queue'
import { getTelegramOpsSetting, normalizeOwnerChatIds, parseOwnerChatIds } from '@/lib/telegram-notification/settings'

export async function GET(req: NextRequest) {
  const denied = await requireRoles(req, ['SUPER_ADMIN', 'ADMIN'])
  if (denied) return denied

  const businessId = resolveBusinessId(req.nextUrl.searchParams.get('business_id'))
  const setting = await getTelegramOpsSetting(businessId)
  const chatIds = normalizeOwnerChatIds(parseOwnerChatIds(setting.ownerChatIds))
  const queue = await getTelegramQueueHealth()

  let telegram: Record<string, unknown> = { botTokenConfigured: Boolean(getTelegramBotToken()) }
  if (getTelegramBotToken()) {
    try {
      const meRes = await fetch(`https://api.telegram.org/bot${getTelegramBotToken()}/getMe`)
      const me = (await meRes.json()) as { ok: boolean; result?: { username?: string; id?: number } }
      const webhook = await getTelegramWebhookInfo()
      telegram = {
        botTokenConfigured: true,
        botUsername: me.result?.username ?? null,
        botOk: me.ok,
        webhook: webhook.result ?? null,
      }
    } catch (e) {
      telegram = { botTokenConfigured: true, error: (e as Error).message }
    }
  }

  return NextResponse.json({
    businessId,
    setting: {
      enabled: setting.enabled,
      ownerChatIdsCount: chatIds.length,
      alertAttendanceCheckIn: setting.alertAttendanceCheckIn,
      alertTradingScreenshot: setting.alertTradingScreenshot,
    },
    queue,
    telegram,
    appUrl: process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || null,
  })
}

/** Reclaim stuck SENDING rows and process up to 25 queued notifications. */
export async function POST(req: NextRequest) {
  const denied = await requireRoles(req, ['SUPER_ADMIN', 'ADMIN'])
  if (denied) return denied

  const reclaimed = await reclaimStuckTelegramSendingRows()
  const processed = await processTelegramNotificationQueue({ limit: 25 })
  const queue = await getTelegramQueueHealth()

  return NextResponse.json({ ok: true, reclaimed, processed, queue })
}
