#!/usr/bin/env node
/**
 * Phase C smoke — approval-blocked duty: pending todo, notify, roster continues.
 *   npx tsx worker/scripts/test-day-shift-phase-c.mjs
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const date = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
const dueStart = new Date(`${date}T00:00:00+06:00`)

async function main() {
  const { tickDayShift, loadDayShiftState } = await import('../../src/agent/lib/day-shift.ts')
  const { dutiesForToday } = await import('../../src/agent/lib/agent-duties.ts')
  const { DUTY_PENDING_APPROVAL_DESCRIPTION } = await import('../../src/agent/lib/duty-approval-block.ts')
  const { buildPendingApprovalReminderPrefix } = await import('../../src/agent/lib/pending-approval-reminder.ts')

  const duties = dutiesForToday().filter((d) => d.duty !== 'salah_init')
  const dispatchIdx = duties.findIndex((d) => d.duty === 'morning_dispatch')
  if (dispatchIdx < 0) {
    console.error('FAIL: morning_dispatch not in roster')
    process.exit(1)
  }

  let state = await loadDayShiftState(date)
  if (!state?.conversationId) {
    console.error('FAIL: no day shift state — run startDayShift first')
    process.exit(1)
  }

  // Force approval block: pending dispatch card for today
  await prisma.agentPendingAction.create({
    data: {
      type: 'dispatch_staff_tasks',
      payload: { date, taskIds: [], source: 'phase_c_test' },
      summary: `📋 Phase C test — ${date} staff tasks`,
      status: 'pending',
    },
  })

  state = { ...state, status: 'running', taskIndex: dispatchIdx }
  await prisma.agentKvSetting.upsert({
    where: { key: `day_shift:${date}` },
    update: { value: JSON.stringify(state) },
    create: { key: `day_shift:${date}`, value: JSON.stringify(state) },
  })

  await prisma.agentTodo.updateMany({
    where: {
      businessId: 'ALMA_LIFESTYLE',
      dutyKey: 'morning_dispatch',
      dueDate: { gte: dueStart },
    },
    data: { status: 'pending', description: null, completedAt: null },
  })

  const idxBefore = state.taskIndex
  const result = await tickDayShift()
  console.log('Tick result:', result)

  const after = await prisma.agentTodo.findFirst({
    where: { dutyKey: 'morning_dispatch', dueDate: { gte: dueStart } },
    select: { status: true, description: true },
  })
  console.log('Todo after:', after)

  const stateAfter = await loadDayShiftState(date)
  console.log('taskIndex:', idxBefore, '→', stateAfter?.taskIndex)

  const blockRow = await prisma.agentPendingAction.findFirst({
    where: { type: 'duty_approval_block', status: 'pending' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, payload: true },
  })
  console.log('duty_approval_block:', blockRow?.id)

  const reminder = await buildPendingApprovalReminderPrefix()
  console.log('Reminder prefix:', reminder.replace(/\n/g, ' | '))

  if (after?.status !== 'pending') {
    console.error('FAIL: todo should be pending')
    process.exit(1)
  }
  if (!after?.description?.includes('approval লাগবে')) {
    console.error('FAIL: missing approval feedback description')
    process.exit(1)
  }
  if ((stateAfter?.taskIndex ?? 0) <= idxBefore) {
    console.error('FAIL: taskIndex should advance (next duty not blocked)')
    process.exit(1)
  }
  if (!blockRow) {
    console.error('FAIL: duty_approval_block not recorded')
    process.exit(1)
  }
  if (!reminder.includes('🔔 Sir')) {
    console.error('FAIL: reminder prefix missing')
    process.exit(1)
  }

  // Escalation poller — synthetic 11 min block should trigger call tier
  const elevenMinAgo = new Date(Date.now() - 11 * 60_000).toISOString()
  await prisma.agentPendingAction.update({
    where: { id: blockRow.id },
    data: {
      payload: {
        ...(blockRow.payload && typeof blockRow.payload === 'object' ? blockRow.payload : {}),
        blockedAt: elevenMinAgo,
        escalationLevel: 0,
      },
    },
  })

  const { pollApprovalEscalations } = await import('../../worker/src/approval/escalation-poller.mjs')
  const esc = await pollApprovalEscalations()
  console.log('Escalation poller:', esc)

  const blockAfter = await prisma.agentPendingAction.findUnique({
    where: { id: blockRow.id },
    select: { payload: true },
  })
  const level = blockAfter?.payload?.escalationLevel ?? 0
  console.log('Escalation level after 11min:', level)

  // Cleanup test rows
  await prisma.agentPendingAction.deleteMany({
    where: {
      OR: [
        { id: blockRow.id },
        { type: 'dispatch_staff_tasks', summary: { contains: 'Phase C test' } },
      ],
    },
  })

  console.log('✅ Phase C smoke OK')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
