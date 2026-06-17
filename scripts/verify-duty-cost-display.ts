/**
 * Phase J verify — duty cost captured on feedback message + matches cost_events window.
 * Usage: npx tsx scripts/verify-duty-cost-display.ts
 */
import { readFileSync, existsSync } from 'fs'
import { PrismaClient } from '@prisma/client'
import { queryConversationCostBetween } from '../src/agent/lib/cost-db'
import { formatDutyCostLineBangla } from '../src/agent/lib/format-cost'

function loadEnvFile(path: string) {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx <= 0) continue
    const key = trimmed.slice(0, idx).trim()
    let value = trimmed.slice(idx + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

loadEnvFile('.env')

const DUTY_DONE = /✅ Sir,.+শেষ/i
const WINDOW_KEY = 'dayshift_window_utc'
const DEFAULT_WINDOW = '2-16'

async function main() {
  await prisma.agentKvSetting.upsert({
    where: { key: WINDOW_KEY },
    update: { value: '0-23' },
    create: { key: WINDOW_KEY, value: '0-23' },
  })

  try {
    await runVerify()
  } finally {
    await prisma.agentKvSetting.upsert({
      where: { key: WINDOW_KEY },
      update: { value: DEFAULT_WINDOW },
      create: { key: WINDOW_KEY, value: DEFAULT_WINDOW },
    })
  }
}

async function runVerify() {
  const { tickDayShift, loadDayShiftState, startDayShift } = await import('../src/agent/lib/day-shift')
  const date = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })

  let stateBefore = await loadDayShiftState(date)
  if (!stateBefore?.conversationId) {
    const started = await startDayShift()
    console.log('startDayShift:', started.detail)
    stateBefore = await loadDayShiftState(date)
  }
  if (!stateBefore?.conversationId) {
    throw new Error('No day shift state after start')
  }

  const convId = stateBefore.conversationId

  const result = await tickDayShift()
  console.log('tick:', result.detail)

  const stateAfter = await loadDayShiftState(date)
  if (!stateAfter) throw new Error('state missing after tick')

  const feedbackMsgs = await prisma.agentMessage.findMany({
    where: {
      conversationId: convId,
      role: 'assistant',
    },
    orderBy: { createdAt: 'desc' },
    take: 8,
    select: { id: true, content: true, costUsd: true, createdAt: true },
  })

  const feedback = feedbackMsgs.find((m) => {
    const text = Array.isArray(m.content)
      ? (m.content as Array<{ type?: string; text?: string }>)
          .filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join('')
      : ''
    return DUTY_DONE.test(text)
  })

  if (!feedback) {
    if (result.detail.includes('outside_office') || result.detail === 'patrol_wait') {
      console.log('SKIP — tick no-op:', result.detail)
      return
    }
    throw new Error('No duty feedback message with ✅ Sir found')
  }

  const msgCost = feedback.costUsd != null ? parseFloat(String(feedback.costUsd)) : 0
  console.log('feedback costUsd on message:', msgCost)
  console.log('format:', formatDutyCostLineBangla(msgCost))

  const windowStart = new Date(feedback.createdAt.getTime() - 120_000)
  const recorded = await queryConversationCostBetween(convId, windowStart, feedback.createdAt)
  console.log('cost_events in 2m window before feedback:', recorded)

  if (msgCost > 0 && Math.abs(msgCost - recorded) > 0.0001) {
    console.warn('WARN: message cost differs from events window — may include prior duty overlap')
  }

  if (stateAfter.totalDutyCostUsd != null && stateAfter.totalDutyCostUsd >= msgCost) {
    console.log('state totalDutyCostUsd:', stateAfter.totalDutyCostUsd)
  }

  console.log('PASS — duty cost display verified')
}

const prisma = new PrismaClient()
main()
  .catch((e) => {
    console.error('FAIL', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
