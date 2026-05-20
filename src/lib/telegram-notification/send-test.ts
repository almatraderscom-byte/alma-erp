import { erpBaseUrl } from '@/lib/telegram-notification/formatters'
import { enqueueTelegramNotification, flushTelegramNotificationQueue } from '@/lib/telegram-notification/queue'
import { resolveOwnerChatIdsWithMeta } from '@/lib/telegram-notification/owner-routing'
import { sendTelegramMessage } from '@/lib/trading-telegram-bot'
import { logTelegram } from '@/lib/telegram-notification/telegram-log'

export async function sendTelegramOwnerTestNotification(businessId: string, actorUserId: string) {
  const routing = await resolveOwnerChatIdsWithMeta(businessId)
  if (!routing.chatIds.length) {
    return {
      ok: false,
      error: routing.source === 'disabled'
        ? 'Telegram Ops is disabled for this business. Enable it first.'
        : 'No valid owner chat IDs in database or TELEGRAM_OWNER_CHAT_IDS env.',
      routing,
    }
  }

  const now = new Date()
  const message = [
    '🧪 <b>Alma ERP — Telegram test</b>',
    '',
    `Business: <code>${businessId}</code>`,
    `Routing: <b>${routing.source}</b>`,
    `Recipients: <b>${routing.chatIds.length}</b>`,
    `Time: ${now.toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' })}`,
    '',
    `<a href="${erpBaseUrl()}/settings/telegram-ops">Open Telegram Ops →</a>`,
  ].join('\n')

  const directResults: Array<{ chatId: string; ok: boolean; errorMessage?: string }> = []
  for (const chatId of routing.chatIds) {
    const started = Date.now()
    const send = await sendTelegramMessage(chatId, message)
    directResults.push({ chatId, ok: send.ok, errorMessage: send.errorMessage })
    logTelegram(send.ok ? 'info' : 'error', send.ok ? 'telegram.send.success' : 'telegram.send.failed', {
      mode: 'test_direct',
      chatId,
      businessId,
      actorUserId,
      latencyMs: Date.now() - started,
      routingSource: routing.source,
      errorCode: send.errorCode,
      error: send.errorMessage,
    })
  }

  const enqueued = await enqueueTelegramNotification({
    businessId,
    eventType: 'OPS_DAILY_SUMMARY',
    message: `${message}\n\n<i>Queued audit copy</i>`,
    dedupeKey: `ops:test:${businessId}:${now.toISOString().slice(0, 16)}`,
    chatIds: routing.chatIds,
    metadata: { type: 'owner_test', force: true, actorUserId, routingSource: routing.source },
  })

  let queueFlush = null
  if (enqueued.ok && enqueued.ids?.length) {
    queueFlush = await flushTelegramNotificationQueue({ ids: enqueued.ids, limit: enqueued.ids.length })
  }

  const allDirectOk = directResults.every(r => r.ok)
  return {
    ok: allDirectOk,
    routing,
    directResults,
    enqueued,
    queueFlush,
    error: allDirectOk ? undefined : 'One or more direct test sends failed — see directResults.',
  }
}
