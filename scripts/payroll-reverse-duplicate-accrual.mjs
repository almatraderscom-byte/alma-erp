/**
 * Reverse duplicate monthly salary accruals when salaries were already paid manually.
 *
 * Typical case: payroll cron on the 10th credits SALARY_ACCRUAL for the current month,
 * but the owner already paid staff outside the normal wallet flow (or via manual payout).
 *
 * Preview (default — no writes):
 *   node --env-file=.env scripts/payroll-reverse-duplicate-accrual.mjs \
 *     --business-id ALMA_LIFESTYLE --period-ym 2026-06
 *
 * Apply reversals (supervised — requires --confirm):
 *   node --env-file=.env scripts/payroll-reverse-duplicate-accrual.mjs \
 *     --business-id ALMA_LIFESTYLE --period-ym 2026-06 --confirm
 */
import { PrismaClient } from '@prisma/client'

const p = new PrismaClient()

const REVERSAL_SOURCE = 'payroll_duplicate_accrual_reversal'

function parseArgs(argv) {
  const out = {
    businessId: process.env.PAYROLL_AUDIT_BUSINESS_ID || 'ALMA_LIFESTYLE',
    periodYm: '2026-06',
    accrualDate: '2026-06-10',
    confirm: false,
  }
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--business-id') out.businessId = String(argv[++i] || '').trim()
    else if (a === '--period-ym') out.periodYm = String(argv[++i] || '').trim()
    else if (a === '--accrual-date') out.accrualDate = String(argv[++i] || '').trim()
    else if (a === '--confirm') out.confirm = true
  }
  return out
}

function dayBounds(isoDate) {
  const start = new Date(`${isoDate}T00:00:00.000Z`)
  const end = new Date(`${isoDate}T23:59:59.999Z`)
  return { start, end }
}

async function loadEmployeeNames(employeeIds) {
  const users = await p.user.findMany({
    where: { employeeIdGas: { in: employeeIds } },
    select: { employeeIdGas: true, name: true },
  })
  return new Map(users.map(u => [u.employeeIdGas, u.name]))
}

async function existingReversalIds(accrualIds) {
  const refs = accrualIds.map(id => `${REVERSAL_SOURCE}:${id}`)
  const rows = await p.employeeLedgerEntry.findMany({
    where: {
      source: REVERSAL_SOURCE,
      sourceRef: { in: refs },
      isArchived: false,
    },
    select: { sourceRef: true },
  })
  return new Set(rows.map(r => String(r.sourceRef || '').replace(`${REVERSAL_SOURCE}:`, '')))
}

async function main() {
  const args = parseArgs(process.argv)
  if (!args.periodYm) {
    console.error('--period-ym is required (e.g. 2026-06)')
    process.exit(1)
  }

  const createdRange = args.accrualDate ? dayBounds(args.accrualDate) : null

  const accruals = await p.employeeLedgerEntry.findMany({
    where: {
      businessId: args.businessId,
      type: 'SALARY_ACCRUAL',
      periodYm: args.periodYm,
      source: 'monthly_accrual',
      isArchived: false,
      ...(createdRange
        ? { createdAt: { gte: createdRange.start, lte: createdRange.end } }
        : {}),
    },
    orderBy: [{ employeeId: 'asc' }],
    select: {
      id: true,
      employeeId: true,
      amount: true,
      date: true,
      periodYm: true,
      note: true,
      sourceRef: true,
      createdAt: true,
    },
  })

  const employeeIds = [...new Set(accruals.map(r => r.employeeId))]
  const nameByEmp = await loadEmployeeNames(employeeIds)
  const alreadyReversed = await existingReversalIds(accruals.map(r => r.id))

  const candidates = accruals.map(row => ({
    accrualId: row.id,
    employeeId: row.employeeId,
    employeeName: nameByEmp.get(row.employeeId) || '(no linked user)',
    amount: Number(row.amount || 0),
    reversalAmount: -Number(row.amount || 0),
    periodYm: row.periodYm,
    accrualDate: row.date.toISOString().slice(0, 10),
    createdAt: row.createdAt.toISOString(),
    note: row.note,
    sourceRef: row.sourceRef,
    alreadyReversed: alreadyReversed.has(row.id),
  }))

  const pending = candidates.filter(c => !c.alreadyReversed)
  const totalPending = pending.reduce((sum, c) => sum + c.amount, 0)

  const accrualRun = await p.payrollAccrualRun.findUnique({
    where: { businessId_periodYm: { businessId: args.businessId, periodYm: args.periodYm } },
    select: { status: true, trigger: true, createdCount: true, startedAt: true, finishedAt: true },
  })

  console.log(
    JSON.stringify(
      {
        mode: args.confirm ? 'apply' : 'preview',
        businessId: args.businessId,
        periodYm: args.periodYm,
        accrualDateFilter: args.accrualDate || null,
        accrualRun,
        accrualCount: candidates.length,
        pendingReversalCount: pending.length,
        alreadyReversedCount: candidates.length - pending.length,
        totalPendingReversalAmount: totalPending,
        candidates,
      },
      null,
      2,
    ),
  )

  if (!args.confirm) {
    console.error(
      '\nPreview only. Review JSON above, then re-run with --confirm to post ADJUSTMENT reversals.\n',
    )
    return
  }

  if (!pending.length) {
    console.error('Nothing to reverse (no pending accruals).')
    return
  }

  const created = []
  for (const row of pending) {
    const sourceRef = `${REVERSAL_SOURCE}:${row.accrualId}`
    const entry = await p.employeeLedgerEntry.create({
      data: {
        employeeId: row.employeeId,
        businessId: args.businessId,
        date: new Date(),
        periodYm: row.periodYm,
        type: 'ADJUSTMENT',
        amount: row.reversalAmount,
        note: `Reverse duplicate monthly accrual ${row.accrualId} (salaries already paid manually)`.slice(0, 800),
        source: REVERSAL_SOURCE,
        sourceRef,
        createdById: null,
        approvedById: null,
      },
    })
    created.push({
      adjustmentId: entry.id,
      accrualId: row.accrualId,
      employeeId: row.employeeId,
      amount: Number(entry.amount),
    })
  }

  console.log(JSON.stringify({ mode: 'applied', createdCount: created.length, created }, null, 2))
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => p.$disconnect())
