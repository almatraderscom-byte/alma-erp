/**
 * Backfill / test screenshot Telegram notification for a recent upload.
 * Usage: node scripts/telegram-screenshot-notify-test.mjs [screenshotId]
 */
import { PrismaClient } from '@prisma/client'

const p = new PrismaClient()
const screenshotId = process.argv[2] || 'cmpcq28k60002m1aryz3eeszp'

async function main() {
  const shot = await p.tradingPerformanceScreenshot.findUnique({
    where: { id: screenshotId },
    include: {
      tradingAccount: { select: { id: true, accountTitle: true } },
      uploader: { select: { name: true } },
    },
  })
  if (!shot) {
    console.error('Screenshot not found:', screenshotId)
    process.exit(1)
  }

  const base = (process.env.NEXTAUTH_URL || 'https://alma-erp-six.vercel.app').replace(/\/$/, '')
  const res = await fetch(`${base}/api/cron/telegram-screenshot-notify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-cron-secret': process.env.CRON_SECRET || '',
    },
    body: JSON.stringify({
      screenshotId: shot.id,
      businessId: shot.businessId,
      accountId: shot.tradingAccountId,
      accountTitle: shot.tradingAccount.accountTitle,
      uploaderName: shot.uploader?.name || 'Staff',
      shotDate: shot.shotDate.toISOString().slice(0, 10),
    }),
  }).catch(e => ({ ok: false, status: 0, text: async () => e.message }))

  const text = await res.text()
  console.log(res.status, text)

  const rows = await p.telegramNotificationQueue.findMany({
    where: { eventType: 'TRADING_SCREENSHOT_UPLOAD' },
    orderBy: { createdAt: 'desc' },
    take: 3,
  })
  console.log('Recent queue:', rows.map(r => ({ id: r.id, status: r.status, err: r.errorMessage })))
  await p.$disconnect()
}

main()
