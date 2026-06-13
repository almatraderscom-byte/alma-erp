#!/usr/bin/env node
/**
 * Verify dhakaMidnightUtc matches ERP attendanceDateFor convention.
 * Usage: node worker/scripts/verify-erp-date-mismatch.mjs
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'

const DHAKA_TZ = 'Asia/Dhaka'
const BIZ = 'ALMA_LIFESTYLE'

function todayYmdDhaka(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: DHAKA_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

function dhakaMidnightUtcNew(ymd) {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

function dhakaMidnightUtcOld(ymd) {
  return new Date(`${ymd}T00:00:00+06:00`)
}

function attendanceDateFor(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DHAKA_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const get = (t) => Number(parts.find((p) => p.type === t)?.value)
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day')))
}

const results = []
function pass(msg, detail) {
  results.push({ ok: true, msg, detail })
  console.log(`✅ ${msg}${detail ? ` — ${detail}` : ''}`)
}
function fail(msg, detail) {
  results.push({ ok: false, msg, detail })
  console.log(`❌ ${msg}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  console.log('=== ERP Date Mismatch Verification ===\n')
  const today = todayYmdDhaka()
  const erpDate = attendanceDateFor()
  const newDate = dhakaMidnightUtcNew(today)
  const oldDate = dhakaMidnightUtcOld(today)

  if (erpDate.getTime() === newDate.getTime()) {
    pass('dhakaMidnightUtc matches attendanceDateFor', `${today} → ${newDate.toISOString()}`)
  } else {
    fail('dhakaMidnightUtc matches attendanceDateFor', `erp=${erpDate.toISOString()} new=${newDate.toISOString()}`)
  }

  if (oldDate.getTime() !== newDate.getTime()) {
    pass('Old convention was 6h off', `old=${oldDate.toISOString()} new=${newDate.toISOString()}`)
  } else {
    fail('Old vs new', 'unexpectedly identical')
  }

  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) {
    fail('Attendance DB compare', 'DATABASE_URL not set')
  } else {
    const prisma = new PrismaClient()
    try {
      const [oldCount, newCount, erpCount] = await Promise.all([
        prisma.attendanceRecord.count({
          where: { businessId: BIZ, isArchived: false, attendanceDate: oldDate },
        }),
        prisma.attendanceRecord.count({
          where: { businessId: BIZ, isArchived: false, attendanceDate: newDate },
        }),
        prisma.attendanceRecord.count({
          where: { businessId: BIZ, isArchived: false, attendanceDate: erpDate },
        }),
      ])
      pass('Attendance count (new)', `${newCount} records for ${today}`)
      if (newCount === erpCount) {
        pass('New query matches ERP date', `${newCount} = ${erpCount}`)
      } else {
        fail('New query matches ERP date', `new=${newCount} erp=${erpCount}`)
      }
      if (oldCount < newCount) {
        pass('Old query under-counted', `old=${oldCount} new=${newCount}`)
      } else if (oldCount === 0 && newCount > 0) {
        pass('Old query returned zero (bug reproduced)', `old=0 new=${newCount}`)
      } else {
        pass('Old query count', `old=${oldCount} (may equal new if no records today)`)
      }

      const weekStart = (() => {
        const [y, m, d] = today.split('-').map(Number)
        const dt = new Date(Date.UTC(y, m - 1, d - 6))
        return dt.toISOString().slice(0, 10)
      })()
      const rangeNew = await prisma.attendanceRecord.count({
        where: {
          businessId: BIZ,
          isArchived: false,
          attendanceDate: { gte: dhakaMidnightUtcNew(weekStart), lte: dhakaMidnightUtcNew(today) },
        },
      })
      pass('7-day attendance range query', `${rangeNew} records ${weekStart}..${today}`)
    } finally {
      await prisma.$disconnect()
    }
  }

  const failed = results.filter((r) => !r.ok).length
  console.log(`\n=== ${failed ? 'FAIL' : 'PASS'} (${results.length - failed}/${results.length}) ===`)
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
