import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const BUSINESS = 'ALMA_TRADING'

async function main() {
  const accounts = await prisma.tradingAccount.findMany({
    where: { businessId: BUSINESS, deletedAt: null },
    select: { id: true, accountTitle: true, status: true },
    take: 20,
  })
  const erpUsers = await prisma.user.findMany({
    where: { active: true },
    select: { id: true, name: true, email: true, role: true },
    take: 30,
  })
  const chats = await prisma.tradingTelegramChat.findMany({ where: { businessId: BUSINESS } })
  const tgUsers = await prisma.tradingTelegramUser.findMany({ where: { businessId: BUSINESS } })
  const aliases = await prisma.tradingAccountAlias.findMany({ where: { businessId: BUSINESS } })
  const audits = await prisma.tradingTelegramAuditLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10,
  })
  const draftCount = await prisma.tradingTelegramDraft.count()
  const indexes = await prisma.$queryRaw`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'TradingTelegramDraft'
    ORDER BY indexname`

  console.log(
    JSON.stringify(
      {
        setup: { chats, tgUsers, aliases },
        availableAccounts: accounts,
        availableErpUsers: erpUsers.filter(u =>
          ['SUPER_ADMIN', 'ADMIN', 'STAFF'].includes(u.role),
        ),
        drafts: draftCount,
        recentAudits: audits,
        draftIndexes: indexes,
      },
      null,
      2,
    ),
  )
}

main()
  .catch(e => {
    console.error(e.message)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
