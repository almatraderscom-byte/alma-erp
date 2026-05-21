import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const cols = await prisma.$queryRaw`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'TradingTelegramDraft'
    ORDER BY column_name`
  const enums = await prisma.$queryRaw`
    SELECT e.enumlabel::text AS label FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'TradingTelegramDraftStatus'
    ORDER BY e.enumsortorder`
  const tables = await prisma.$queryRaw`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name LIKE 'TradingTelegram%'
    ORDER BY table_name`

  console.log(JSON.stringify({ cols, enums, tables }, null, 2))
}

main()
  .catch(e => {
    console.error(e.message)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
