import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const BUSINESS = 'ALMA_TRADING'

async function main() {
  const chats = await prisma.tradingTelegramChat.findMany({
    where: { businessId: BUSINESS },
    select: { id: true, chatId: true, title: true, approved: true },
  })
  const users = await prisma.tradingTelegramUser.findMany({
    where: { businessId: BUSINESS },
    include: {
      user: { select: { id: true, name: true, email: true, role: true, active: true } },
    },
  })
  const aliases = await prisma.tradingAccountAlias.findMany({
    where: { businessId: BUSINESS, active: true },
    include: { tradingAccount: { select: { id: true, accountTitle: true, status: true } } },
  })

  console.log(
    JSON.stringify(
      {
        chats,
        users: users.map(u => ({
          telegramUserId: u.telegramUserId,
          telegramUsername: u.telegramUsername,
          approved: u.approved,
          defaultAccountAlias: u.defaultAccountAlias,
          erpUser: u.user,
        })),
        aliases: aliases.map(a => ({
          alias: a.alias,
          accountTitle: a.tradingAccount?.accountTitle,
          accountStatus: a.tradingAccount?.status,
        })),
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
