import { prisma } from '@/lib/prisma'
import { moneyDecimal } from '@/lib/payroll-wallet'

export const PAYROLL_DUPLICATE_ACCRUAL_REVERSAL_SOURCE = 'payroll_duplicate_accrual_reversal'

export type ReverseDuplicateAccrualInput = {
  businessId: string
  periodYm: string
  accrualDate?: string | null
  confirm?: boolean
}

export type ReverseDuplicateAccrualCandidate = {
  accrualId: string
  employeeId: string
  employeeName: string
  amount: number
  reversalAmount: number
  periodYm: string | null
  accrualDate: string
  createdAt: string
  note: string | null
  sourceRef: string | null
  alreadyReversed: boolean
}

function dayBounds(isoDate: string) {
  const start = new Date(`${isoDate}T00:00:00.000Z`)
  const end = new Date(`${isoDate}T23:59:59.999Z`)
  return { start, end }
}

async function loadEmployeeNames(employeeIds: string[]) {
  if (!employeeIds.length) return new Map<string, string>()
  const users = await prisma.user.findMany({
    where: { employeeIdGas: { in: employeeIds } },
    select: { employeeIdGas: true, name: true },
  })
  return new Map(users.map(u => [u.employeeIdGas || '', u.name]))
}

async function existingReversalIds(accrualIds: string[]) {
  if (!accrualIds.length) return new Set<string>()
  const refs = accrualIds.map(id => `${PAYROLL_DUPLICATE_ACCRUAL_REVERSAL_SOURCE}:${id}`)
  const rows = await prisma.employeeLedgerEntry.findMany({
    where: {
      source: PAYROLL_DUPLICATE_ACCRUAL_REVERSAL_SOURCE,
      sourceRef: { in: refs },
      isArchived: false,
    },
    select: { sourceRef: true },
  })
  return new Set(rows.map(r => String(r.sourceRef || '').replace(`${PAYROLL_DUPLICATE_ACCRUAL_REVERSAL_SOURCE}:`, '')))
}

export async function reverseDuplicatePayrollAccruals(input: ReverseDuplicateAccrualInput) {
  const businessId = String(input.businessId || '').trim()
  const periodYm = String(input.periodYm || '').trim()
  if (!businessId || !periodYm) {
    throw new Error('businessId and periodYm are required')
  }

  const createdRange = input.accrualDate?.trim() ? dayBounds(input.accrualDate.trim()) : null
  const accruals = await prisma.employeeLedgerEntry.findMany({
    where: {
      businessId,
      type: 'SALARY_ACCRUAL',
      periodYm,
      source: 'monthly_accrual',
      isArchived: false,
      ...(createdRange ? { createdAt: { gte: createdRange.start, lte: createdRange.end } } : {}),
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

  const candidates: ReverseDuplicateAccrualCandidate[] = accruals.map(row => ({
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
  const totalPendingReversalAmount = pending.reduce((sum, c) => sum + c.amount, 0)
  const accrualRun = await prisma.payrollAccrualRun.findUnique({
    where: { businessId_periodYm: { businessId, periodYm } },
    select: { status: true, trigger: true, createdCount: true, startedAt: true, finishedAt: true },
  })

  const preview = {
    mode: input.confirm ? 'apply' : 'preview',
    businessId,
    periodYm,
    accrualDateFilter: input.accrualDate || null,
    accrualRun,
    accrualCount: candidates.length,
    pendingReversalCount: pending.length,
    alreadyReversedCount: candidates.length - pending.length,
    totalPendingReversalAmount,
    candidates,
  }

  if (!input.confirm) {
    return { ok: true, applied: false, ...preview }
  }

  if (!pending.length) {
    return { ok: true, applied: false, message: 'Nothing to reverse', ...preview }
  }

  const created: Array<{ adjustmentId: string; accrualId: string; employeeId: string; amount: number }> = []
  for (const row of pending) {
    const sourceRef = `${PAYROLL_DUPLICATE_ACCRUAL_REVERSAL_SOURCE}:${row.accrualId}`
    const entry = await prisma.employeeLedgerEntry.create({
      data: {
        employeeId: row.employeeId,
        businessId,
        date: new Date(),
        periodYm: row.periodYm,
        type: 'ADJUSTMENT',
        amount: moneyDecimal(row.reversalAmount),
        note: `Reverse duplicate monthly accrual ${row.accrualId} (salaries already paid manually)`.slice(0, 800),
        source: PAYROLL_DUPLICATE_ACCRUAL_REVERSAL_SOURCE,
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

  return {
    ok: true,
    applied: true,
    createdCount: created.length,
    created,
    ...preview,
  }
}
