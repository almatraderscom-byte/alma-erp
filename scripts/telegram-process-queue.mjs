/**
 * Process Telegram notification queue (reclaim stuck + deliver).
 * Run: node --env-file=.env --env-file=.env.telegram scripts/telegram-process-queue.mjs
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
const API = 'https://api.telegram.org'

async function sendMessage(chatId, text, replyMarkup) {
  const body = { chat_id: chatId, text, parse_mode: 'HTML' }
  if (replyMarkup) body.reply_markup = replyMarkup
  const res = await fetch(`${API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

async function main() {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN missing')

  const cutoff = new Date(Date.now() - 2 * 60_000)
  await prisma.telegramNotificationQueue.updateMany({
    where: { status: 'SENDING', updatedAt: { lt: cutoff } },
    data: { status: 'QUEUED', errorMessage: 'reclaimed', nextAttemptAt: null },
  })

  const rows = await prisma.telegramNotificationQueue.findMany({
    where: { status: { in: ['QUEUED', 'FAILED'] }, attempts: { lt: 3 } },
    orderBy: { createdAt: 'asc' },
    take: 10,
  })

  for (const row of rows) {
    await prisma.telegramNotificationQueue.update({
      where: { id: row.id },
      data: { status: 'SENDING', attempts: { increment: 1 } },
    })
    let meta = {}
    try {
      meta = row.metadataJson ? JSON.parse(row.metadataJson) : {}
    } catch {
      meta = {}
    }
    const replyMarkup = meta.replyMarkup
    const result = await sendMessage(row.chatId, row.message, replyMarkup)
    if (result.ok) {
      await prisma.telegramNotificationQueue.update({
        where: { id: row.id },
        data: { status: 'SENT', sentAt: new Date(), errorMessage: null },
      })
      console.log('SENT', row.id, row.eventType)
    } else {
      await prisma.telegramNotificationQueue.update({
        where: { id: row.id },
        data: { status: 'FAILED', errorMessage: String(result.description || 'failed').slice(0, 500) },
      })
      console.log('FAILED', row.id, result.description)
    }
  }

  const stats = await prisma.telegramNotificationQueue.groupBy({ by: ['status'], _count: { _all: true } })
  console.log('stats', stats)
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
