#!/usr/bin/env node
/**
 * Phase D smoke — owner task intake + no-task streak + advisor path.
 *   npx tsx worker/scripts/test-day-shift-phase-d.mjs
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })

function tomorrowFrom(ymd) {
  const d = new Date(`${ymd}T12:00:00+06:00`)
  d.setDate(d.getDate() + 1)
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

async function cleanup() {
  const tomorrow = tomorrowFrom(today)
  await prisma.agentKvSetting.deleteMany({
    where: {
      OR: [
        { key: { startsWith: 'owner_intake_' } },
        { key: { startsWith: 'owner_no_task:' } },
      ],
    },
  })
  await prisma.agentTodo.deleteMany({
    where: {
      source: 'owner',
      title: { contains: 'Phase D test' },
    },
  })
  void tomorrow
}

async function main() {
  await cleanup()

  const {
    runOwnerTaskIntakeSend,
    processOwnerIntakeReply,
    composeOwnerTaskIntakeMessage,
    countConsecutiveNoTaskDays,
    tomorrowYmdDhaka,
  } = await import('../../src/agent/lib/owner-task-intake.ts')

  // 1 — normal intake message
  const normal = await composeOwnerTaskIntakeMessage(today)
  console.log('Normal intake:', normal.message.slice(0, 60), '...')
  if (!normal.message.includes('কালকের জন্য')) {
    console.error('FAIL: missing intake prompt')
    process.exit(1)
  }

  const send = await runOwnerTaskIntakeSend()
  console.log('Send:', send.ok, 'streak', send.streak)
  if (!send.ok) {
    console.error('FAIL: intake send')
    process.exit(1)
  }

  // 2 — owner adds tasks
  const tomorrow = tomorrowYmdDhaka(today)
  const added = await processOwnerIntakeReply(
    'Phase D test: supplier call, Dubai paperwork sort',
    'test-conv',
  )
  console.log('Tasks reply:', added?.autoReply?.slice(0, 80))
  const todos = await prisma.agentTodo.findMany({
    where: { source: 'owner', dueDate: { gte: new Date(`${tomorrow}T00:00:00+06:00`) } },
    select: { title: true },
  })
  console.log('Owner todos for tomorrow:', todos.map((t) => t.title))
  if (todos.length < 2) {
    console.error('FAIL: expected 2+ owner todos')
    process.exit(1)
  }

  await cleanup()

  // 3 — no task decline
  await runOwnerTaskIntakeSend()
  const no = await processOwnerIntakeReply('kichu korbo na kal', 'test-conv')
  console.log('No-task reply:', no?.autoReply)
  if (no?.autoReply !== 'ঠিক আছে Sir, কালকের জন্য কিছু রাখছি না।') {
    console.error('FAIL: wrong no-task accept')
    process.exit(1)
  }
  const marker = await prisma.agentKvSetting.findUnique({
    where: { key: `owner_no_task:${tomorrow}` },
  })
  if (!marker) {
    console.error('FAIL: no_task marker missing')
    process.exit(1)
  }

  // Second message same evening should not re-process (resolved)
  const again = await processOwnerIntakeReply('ar ekta kaj', 'test-conv')
  if (again !== null) {
    console.error('FAIL: should stay silent after no_task resolved')
    process.exit(1)
  }
  console.log('After no_task: intake silent ✓')

  await cleanup()

  // 4 — 2-day streak nudge
  const y1 = today
  const y2 = (() => {
    const d = new Date(`${today}T12:00:00+06:00`)
    d.setDate(d.getDate() - 1)
    return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
  })()
  await prisma.agentKvSetting.create({
    data: { key: `owner_no_task:${y1}`, value: 'true' },
  })
  await prisma.agentKvSetting.create({
    data: { key: `owner_no_task:${y2}`, value: 'true' },
  })
  const streak = await countConsecutiveNoTaskDays(today)
  console.log('Streak:', streak)
  const nudged = await composeOwnerTaskIntakeMessage(today)
  if (streak < 2 || !nudged.message.includes('২ দিন')) {
    console.error('FAIL: 2-day nudge not shown')
    process.exit(1)
  }
  console.log('2-day nudge ✓')

  await runOwnerTaskIntakeSend()
  const advisor = await processOwnerIntakeReply(
    'somossa hocche, stress onek, ar korte parbo na',
    'test-conv',
  )
  console.log('Advisor mode:', advisor?.forcePersonalMode, Boolean(advisor?.contextBlock))
  if (!advisor?.forcePersonalMode) {
    console.error('FAIL: advisor mode not triggered')
    process.exit(1)
  }

  await cleanup()
  console.log('✅ Phase D smoke OK')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
