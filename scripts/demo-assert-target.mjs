/**
 * demo-assert-target.mjs — refuse to touch anything that is not the demo database.
 *
 * The nightly reset runs `prisma db push --accept-data-loss` before the seed, and
 * `--accept-data-loss` means exactly what it says: it will drop columns and tables
 * without asking. If `DEMO_DATABASE_URL` were ever pointed at production, the seed's
 * own guard would come too late — the schema would already have been rewritten.
 *
 * So this runs FIRST, before any statement that can alter the target.
 *
 * The signal is the user table: a real ALMA database always holds staff accounts
 * that are not `@alma-erp.demo`. Deliberately not order ids — an order a visitor
 * creates through the demo UI carries a normal id and must not look like production.
 *
 *   DATABASE_URL=<demo-db> node scripts/demo-assert-target.mjs
 */
import { PrismaClient } from '@prisma/client'

const DEMO_EMAIL_SUFFIX = '@alma-erp.demo'
const prisma = new PrismaClient()

try {
  let realUsers = 0
  try {
    realUsers = await prisma.user.count({ where: { NOT: { email: { endsWith: DEMO_EMAIL_SUFFIX } } } })
  } catch (e) {
    // No User table yet — a brand new database that has never been pushed to. That is
    // a legitimate target; anything else is a connection problem worth failing on.
    const msg = e instanceof Error ? e.message : String(e)
    if (!/does not exist|P2021/i.test(msg)) throw e
    console.log('· target has no User table yet — treating as a fresh demo database')
    process.exit(0)
  }

  if (realUsers > 0) {
    console.error(
      `REFUSING: target holds ${realUsers} non-demo user(s). `
      + 'This looks like a REAL database — check DEMO_DATABASE_URL before anything writes to it.',
    )
    process.exit(1)
  }

  console.log('· target verified as a demo database (no non-demo users)')
} finally {
  await prisma.$disconnect()
}
