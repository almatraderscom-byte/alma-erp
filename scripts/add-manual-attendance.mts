/**
 * Admin backfill: create attendance for an employee with explicit check-in/out and penalty.
 *
 * Example (Mustahid — 12:00 check-in, ৳300 fine, 19:30 check-out BD):
 *   npx tsx --env-file=.env.local scripts/add-manual-attendance.mts \
 *     --employee EMP-528C8ECB6D --date 2026-06-11 --check-in 12:00 --check-out 19:30 --penalty 300
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { prisma } from '../src/lib/prisma.ts'
import { attendanceDateFor, postAttendancePenalty } from '../src/lib/attendance.ts'
import { moneyDecimal } from '../src/lib/payroll-wallet.ts'

function parseArgs(argv: string[]) {
  const out = {
    employeeId: 'EMP-528C8ECB6D',
    businessId: 'ALMA_LIFESTYLE',
    date: '',
    checkIn: '12:00',
    checkOut: '',
    penalty: 300,
    lateMinutes: 180,
    note: 'Manual attendance added by admin (office arrival 12:00)',
  }
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--employee') out.employeeId = String(argv[++i] || '').trim()
    else if (a === '--date') out.date = String(argv[++i] || '').trim()
    else if (a === '--check-in') out.checkIn = String(argv[++i] || '').trim()
    else if (a === '--check-out') out.checkOut = String(argv[++i] || '').trim()
    else if (a === '--penalty') out.penalty = Number(argv[++i] || 0)
    else if (a === '--late-minutes') out.lateMinutes = Number(argv[++i] || 0)
    else if (a === '--note') out.note = String(argv[++i] || '').trim()
  }
  if (!out.date) {
    const bd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    out.date = bd
  }
  return out
}

function bdDateTimeIso(dateYmd: string, hhmm: string): Date {
  const [y, m, d] = dateYmd.split('-').map(Number)
  const [hh, mm] = hhmm.split(':').map(Number)
  // Asia/Dhaka = UTC+6
  return new Date(Date.UTC(y, m - 1, d, (hh || 0) - 6, mm || 0, 0))
}

async function main() {
  const args = parseArgs(process.argv)
  const user = await prisma.user.findFirst({
    where: { employeeIdGas: args.employeeId, active: true },
    select: { id: true, name: true },
  })
  if (!user) throw new Error(`No active user for ${args.employeeId}`)

  const attendanceDate = attendanceDateFor(bdDateTimeIso(args.date, '12:00'))
  const existing = await prisma.attendanceRecord.findUnique({
    where: {
      businessId_employeeId_attendanceDate: {
        businessId: args.businessId,
        employeeId: args.employeeId,
        attendanceDate,
      },
    },
  })
  if (existing) throw new Error(`Attendance already exists for ${args.date}: ${existing.id}`)

  const checkInAt = bdDateTimeIso(args.date, args.checkIn)
  const checkOutAt = args.checkOut ? bdDateTimeIso(args.date, args.checkOut) : null
  const totalWorkMinutes = checkOutAt
    ? Math.max(0, Math.round((checkOutAt.getTime() - checkInAt.getTime()) / 60000))
    : 0

  const admin = await prisma.user.findFirst({
    where: { role: 'SUPER_ADMIN', active: true },
    select: { id: true },
  })

  const record = await prisma.attendanceRecord.create({
    data: {
      businessId: args.businessId,
      userId: user.id,
      employeeId: args.employeeId,
      attendanceDate,
      status: 'PRESENT',
      officeStartMinutes: 9 * 60,
      officeEndMinutes: 21 * 60,
      checkInAt,
      checkOutAt,
      totalWorkMinutes,
      lateMinutes: args.lateMinutes,
      penaltyAmount: moneyDecimal(args.penalty),
      trustStatus: 'TRUSTED',
      suspiciousReasons: [],
      faceVerified: false,
      sessionInfo: JSON.stringify({ manual: true, note: args.note, addedBy: 'admin_script' }),
    },
  })

  let penaltyLedgerEntryId: string | null = null
  if (args.penalty > 0) {
    const entry = await postAttendancePenalty(record, admin?.id || null)
    penaltyLedgerEntryId = entry?.id || null
  }

  console.log(JSON.stringify({
    ok: true,
    employee: user.name,
    employeeId: args.employeeId,
    date: args.date,
    checkInAt: checkInAt.toISOString(),
    checkOutAt: checkOutAt?.toISOString() || null,
    lateMinutes: args.lateMinutes,
    penalty: args.penalty,
    totalWorkMinutes,
    recordId: record.id,
    penaltyLedgerEntryId,
  }, null, 2))
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
