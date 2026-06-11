#!/usr/bin/env node
/** Smoke test for Phase 8 cost dashboard queries (uses DATABASE_URL from .env). */
import { Prisma, PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  await prisma.$queryRaw(Prisma.sql`SELECT 1 FROM agent_cost_events LIMIT 1`)
  await prisma.$queryRaw(Prisma.sql`SELECT 1 FROM agent_subscriptions LIMIT 1`)
  const subs = await prisma.agentSubscription.findMany({ where: { active: true } })
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
  const start = new Date(`${todayStr}T00:00:00+06:00`)
  const end = new Date(start.getTime() + 86400000)
  const sum = await prisma.$queryRaw(
    Prisma.sql`SELECT COALESCE(SUM(cost_usd), 0)::text AS total FROM agent_cost_events WHERE occurred_at >= ${start} AND occurred_at < ${end}`,
  )
  console.log('cost-dashboard smoke OK', { subs: subs.length, todayUsd: sum[0]?.total })
}

main()
  .catch((e) => {
    console.error('FAIL', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
