import { prisma } from '@/lib/prisma'
import { getTelegramBotToken, getTelegramWebhookInfo } from '@/lib/trading-telegram-bot'
import { getTelegramQueueHealth, STUCK_SENDING_MS } from '@/lib/telegram-notification/queue'
import { getTelegramOpsSetting } from '@/lib/telegram-notification/settings'
import { resolveOwnerChatIdsWithMeta } from '@/lib/telegram-notification/owner-routing'
import { logTelegram } from '@/lib/telegram-notification/telegram-log'

const APP_URL = () =>
  process.env.NEXT_PUBLIC_APP_URL
  || process.env.NEXTAUTH_URL
  || 'https://alma-erp-six.vercel.app'

const BOT_DIAG_TIMEOUT_MS = 8_000

async function fetchTelegramApiJson<T>(url: string, timeoutMs = BOT_DIAG_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { cache: 'no-store', signal: controller.signal })
    const data = (await res.json()) as T
    return data
  } finally {
    clearTimeout(timer)
  }
}

/** Outbound bot health — same TELEGRAM_BOT_TOKEN as queue delivery. */
export async function fetchTelegramBotDiagnostics() {
  const token = getTelegramBotToken()
  if (!token) {
    return {
      botTokenConfigured: false,
      botOk: false,
      botError: 'TELEGRAM_BOT_TOKEN is not set in environment',
      botUsername: null as string | null,
      webhook: null,
      webhookHealthy: false,
      webhookNote: 'Inbound trading webhook only — not required for outbound attendance alerts',
    }
  }

  try {
    const expectedUrl = `${APP_URL().replace(/\/$/, '')}/api/telegram/webhook`
    const [me, webhook] = await Promise.all([
      fetchTelegramApiJson<{ ok: boolean; result?: { username?: string; id?: number; first_name?: string }; description?: string }>(
        `https://api.telegram.org/bot${token}/getMe`,
      ),
      getTelegramWebhookInfo().catch((e: Error) => ({ ok: false, error: e.message, result: undefined })),
    ])
    const webhookResult = webhook.result as Record<string, unknown> | undefined
    const webhookUrl = typeof webhookResult?.url === 'string' ? webhookResult.url : null
    const webhookHealthy = Boolean(webhook.ok && webhookUrl && webhookUrl === expectedUrl)
    const webhookNote = webhookHealthy
      ? 'Trading inbound webhook registered'
      : webhookUrl
        ? `Webhook points elsewhere (${webhookUrl})`
        : 'No inbound webhook — outbound alerts still work'

    logTelegram(webhookHealthy ? 'info' : 'warn', 'telegram.webhook.health', {
      webhookHealthy,
      webhookUrl,
      expectedUrl,
      pendingUpdateCount: webhookResult?.pending_update_count,
    })

    if (!me.ok) {
      return {
        botTokenConfigured: true,
        botOk: false,
        botError: me.description || 'Telegram getMe returned ok:false',
        botUsername: null,
        webhook: webhookResult ?? null,
        webhookHealthy,
        webhookUrl,
        expectedWebhookUrl: expectedUrl,
        webhookNote,
      }
    }

    return {
      botTokenConfigured: true,
      botOk: true,
      botError: null as string | null,
      botId: me.result?.id ?? null,
      botUsername: me.result?.username ?? null,
      botName: me.result?.first_name ?? null,
      webhook: webhookResult ?? null,
      webhookHealthy,
      expectedWebhookUrl: expectedUrl,
      webhookUrl,
      webhookNote,
    }
  } catch (e) {
    const message = (e as Error).name === 'AbortError'
      ? `Telegram getMe timed out after ${BOT_DIAG_TIMEOUT_MS}ms`
      : (e as Error).message
    return {
      botTokenConfigured: true,
      botOk: false,
      botError: message,
      botUsername: null,
      webhook: null,
      webhookHealthy: false,
      webhookNote: 'Inbound trading webhook only — not required for outbound attendance alerts',
    }
  }
}

export function ownerRoutingHealthLabel(
  routing: Awaited<ReturnType<typeof resolveOwnerChatIdsWithMeta>>,
  opsEnabled: boolean,
) {
  if (!opsEnabled) return { label: 'Disabled for this business', tone: 'warn' as const }
  if (routing.chatIds.length > 0) {
    const sourceLabel =
      routing.source === 'database'
        ? 'Database'
        : routing.source === 'env_fallback'
          ? 'Env fallback'
          : routing.source
    return { label: `${sourceLabel} · ${routing.chatIds.length} recipient(s)`, tone: 'ok' as const }
  }
  return { label: 'No valid recipients (DB + env empty)', tone: 'bad' as const }
}

export async function getTelegramOpsDashboard(businessId: string) {
  const since24h = new Date(Date.now() - 24 * 60 * 60_000)
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60_000)

  const [setting, routing, queueBase, telegram, lastSent, lastFailed, failed24h, pendingCount, retryableFailed, recentFailures, avgLatency] =
    await Promise.all([
      getTelegramOpsSetting(businessId),
      resolveOwnerChatIdsWithMeta(businessId),
      getTelegramQueueHealth(businessId),
      fetchTelegramBotDiagnostics(),
      prisma.telegramNotificationQueue.findFirst({
        where: { businessId, status: 'SENT', sentAt: { not: null } },
        orderBy: { sentAt: 'desc' },
        select: { id: true, eventType: true, sentAt: true, chatId: true, attempts: true },
      }),
      prisma.telegramNotificationQueue.findFirst({
        where: { businessId, status: 'FAILED' },
        orderBy: { updatedAt: 'desc' },
        select: { id: true, eventType: true, errorMessage: true, updatedAt: true, chatId: true, attempts: true },
      }),
      prisma.telegramNotificationQueue.count({
        where: { businessId, status: 'FAILED', updatedAt: { gte: since24h } },
      }),
      prisma.telegramNotificationQueue.count({
        where: { businessId, status: { in: ['QUEUED', 'SENDING'] } },
      }),
      prisma.telegramNotificationQueue.count({
        where: {
          businessId,
          status: 'FAILED',
          OR: [{ nextAttemptAt: { not: null } }, { attempts: { lt: 3 } }],
        },
      }),
      prisma.telegramNotificationQueue.findMany({
        where: { businessId, status: 'FAILED', updatedAt: { gte: since7d } },
        orderBy: { updatedAt: 'desc' },
        take: 8,
        select: {
          id: true,
          eventType: true,
          status: true,
          chatId: true,
          attempts: true,
          errorMessage: true,
          updatedAt: true,
          createdAt: true,
        },
      }),
      prisma.telegramNotificationQueue.aggregate({
        where: { businessId, status: 'SENT', sentAt: { gte: since24h } },
        _avg: { attempts: true },
        _count: { _all: true },
      }),
    ])

  const stats7d = await prisma.telegramNotificationQueue.groupBy({
    by: ['status'],
    where: { businessId, createdAt: { gte: since7d } },
    _count: { _all: true },
  })

  const ownerRoutingHealth = ownerRoutingHealthLabel(routing, setting.enabled)

  return {
    businessId,
    appUrl: APP_URL(),
    setting: {
      enabled: setting.enabled,
      ownerChatIdsRaw: setting.ownerChatIds,
    },
    ownerRouting: routing,
    ownerRoutingHealth,
    queue: {
      ...queueBase,
      businessPending: pendingCount,
      businessFailed24h: failed24h,
      businessRetryableFailed: retryableFailed,
      stats7d: stats7d.map(s => ({ status: s.status, count: s._count._all })),
      stuckSendingThresholdMinutes: Math.round(STUCK_SENDING_MS / 60_000),
      architecture: 'async_enqueue_cron_deliver',
    },
    delivery: {
      lastSuccessfulSend: lastSent
        ? {
            id: lastSent.id,
            eventType: lastSent.eventType,
            sentAt: lastSent.sentAt?.toISOString() ?? null,
            chatId: lastSent.chatId,
            attempts: lastSent.attempts,
          }
        : null,
      lastFailed: lastFailed
        ? {
            id: lastFailed.id,
            eventType: lastFailed.eventType,
            at: lastFailed.updatedAt.toISOString(),
            errorMessage: lastFailed.errorMessage,
            chatId: lastFailed.chatId,
            attempts: lastFailed.attempts,
          }
        : null,
      sentLast24h: avgLatency._count._all,
      avgAttemptsLast24h: avgLatency._avg.attempts,
      recentFailures: recentFailures.map(r => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
    },
    telegram,
  }
}
