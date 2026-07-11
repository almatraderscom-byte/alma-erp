#!/usr/bin/env node
/**
 * Phase B smoke — one day-shift tick + todo lockstep check.
 *   npx tsx worker/scripts/test-day-shift-phase-b.mjs
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const date = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
const dueStart = new Date(`${date}T00:00:00+06:00`)

async function main() {
  const { tickDayShift, loadDayShiftState } = await import('../../src/agent/lib/day-shift.ts')
  const { dutiesForToday } = await import('../../src/agent/lib/agent-duties.ts')

  const duties = dutiesForToday().filter((d) => d.duty !== 'salah_init')
  let state = await loadDayShiftState(date)
  if (!state) {
    console.error('FAIL: no day shift state — run startDayShift first')
    process.exit(1)
  }

  const idx = Math.min(state.taskIndex, duties.length - 1)
  const duty = duties[idx]
  console.log('Tick duty:', duty.duty, duty.label, 'index', idx)

  await prisma.agentTodo.updateMany({
    where: {
      businessId: 'ALMA_LIFESTYLE',
      dutyKey: duty.duty,
      dueDate: { gte: dueStart },
    },
    data: { status: 'pending', description: null, completedAt: null },
  })

  state = { ...state, status: 'running', taskIndex: idx }
  await prisma.agentKvSetting.upsert({
    where: { key: `day_shift:${date}` },
    update: { value: JSON.stringify(state) },
    create: { key: `day_shift:${date}`, value: JSON.stringify(state) },
  })

  const before = await prisma.agentTodo.findFirst({
    where: { dutyKey: duty.duty, dueDate: { gte: dueStart } },
    select: { status: true, description: true },
  })
  console.log('Before:', before)

  const result = await tickDayShift()
  console.log('Tick result:', result)

  const after = await prisma.agentTodo.findFirst({
    where: { dutyKey: duty.duty, dueDate: { gte: dueStart } },
    select: { status: true, description: true },
  })
  console.log('After:', after)

  const msgs = await prisma.agentMessage.findMany({
    where: { conversationId: state.conversationId },
    orderBy: { createdAt: 'desc' },
    take: 4,
    select: { content: true },
  })
  for (const m of msgs.reverse()) {
    const text = (m.content)?.[0]?.text?.slice(0, 120) ?? ''
    console.log('MSG:', text.replace(/\n/g, ' '))
  }

  const { getDayShiftToday } = await import('../../src/agent/lib/day-shift.ts')
  const shift = await getDayShiftToday()
  console.log('Banner active:', shift.active, 'status:', shift.state?.status)

  if (after?.status !== 'completed') {
    console.error('FAIL: todo not completed')
    process.exit(1)
  }
  if (!after?.description?.includes('Boss,')) {
    console.error('FAIL: missing feedback description')
    process.exit(1)
  }
  console.log('✅ Phase B smoke OK')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
