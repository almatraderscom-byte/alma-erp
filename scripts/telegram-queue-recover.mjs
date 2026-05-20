/**
 * Reclaim stuck SENDING Telegram queue rows and process them.
 * Run: node scripts/telegram-queue-recover.mjs
 */
import { PrismaClient } from '@prisma/client'

const STUCK_MS = 2 * 60_000
const prisma = new PrismaClient()

async function main() {
  const cutoff = new Date(Date.now() - STUCK_MS)
  const reclaimed = await prisma.telegramNotificationQueue.updateMany({
    where: { status: 'SENDING', updatedAt: { lt: cutoff } },
    data: { status: 'QUEUED', errorMessage: 'reclaimed_from_stuck_sending', nextAttemptAt: null },
  })
  console.log('reclaimed', reclaimed.count)

  const queued = await prisma.telegramNotificationQueue.findMany({
    where: { status: { in: ['QUEUED', 'FAILED'] }, attempts: { lt: 3 } },
    orderBy: { createdAt: 'asc' },
    take: 25,
  })
  console.log('pending', queued.length, queued.map(r => ({ id: r.id, eventType: r.eventType, status: r.status })))

  const stats = await prisma.telegramNotificationQueue.groupBy({ by: ['status'], _count: { _all: true } })
  console.log('stats', stats)
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
