import { prisma } from '@/lib/prisma'
import { serverGet } from '@/lib/server-api'
import { moneyDecimal, periodFromDate } from '@/lib/payroll-wallet'
import { notifyAdminsFailure, notifyUser } from '@/lib/notifications'
import { errorMeta, logEvent } from '@/lib/logger'
import type { HREmployeesApi } from '@/types/hr'
import { enqueueSalaryReceivedSms } from '@/services/sms/events'

type AccrualRunInput = {
  businessId: string
  periodYm?: string
  runById?: string
  trigger?: string
  force?: boolean
}

function periodStart(periodYm: string): Date {
  return new Date(`${periodYm}-01T00:00:00.000Z`)
}

export async function runPayrollAccrual({
  businessId,
  periodYm = periodFromDate(),
  runById,
  trigger = 'manual',
  force = false,
}: AccrualRunInput) {
  const staleCutoff = new Date(Date.now() - 60 * 60 * 1000)
  const existingRun = await prisma.payrollAccrualRun.findUnique({
    where: { businessId_periodYm: { businessId, periodYm } },
  })
  if (existingRun?.status === 'SUCCESS' && !force) {
    return {
      ok: true,
      businessId,
      periodYm,
      employeeCount: existingRun.employeeCount,
      createdCount: 0,
      skippedCount: existingRun.employeeCount,
      errors: [],
      duplicatePrevented: true,
    }
  }
  if (existingRun?.status === 'RUNNING' && existingRun.startedAt > staleCutoff && !force) {
    return {
      ok: false,
      businessId,
      periodYm,
      employeeCount: 0,
      createdCount: 0,
      skippedCount: 0,
      errors: ['Accrual already running; retry later.'],
      retryProtected: true,
    }
  }

  await prisma.payrollAccrualRun.upsert({
    where: { businessId_periodYm: { businessId, periodYm } },
    update: { status: 'RUNNING', trigger, error: null, runById: runById || null, startedAt: new Date(), finishedAt: null },
    create: { businessId, periodYm, status: 'RUNNING', trigger, runById: runById || null },
  })

  const employees = await loadAccrualEmployees(businessId)

  let createdCount = 0
  let skippedCount = 0
  const errors: string[] = []

  for (const employee of employees) {
    const salary = Number(employee.monthly_salary || 0)
    if (!employee.emp_id || salary <= 0) {
      skippedCount += 1
      continue
    }

    try {
      const existing = await prisma.employeeLedgerEntry.findUnique({
        where: {
          employeeId_businessId_periodYm_type: {
            employeeId: employee.emp_id,
            businessId,
            periodYm,
            type: 'SALARY_ACCRUAL',
          },
        },
      })
      if (existing) {
        skippedCount += 1
        continue
      }

      const employeeEmail = employee.email?.trim().toLowerCase()
      const linked = await prisma.user.findFirst({
        where: {
          active: true,
          OR: [
            ...(employeeEmail ? [{ email: employeeEmail }] : []),
            { employeeIdGas: employee.emp_id },
          ],
        },
        select: { id: true, phone: true },
      })

      const entry = await prisma.employeeLedgerEntry.create({
        data: {
          employeeId: employee.emp_id,
          userId: linked?.id || null,
          businessId,
          periodYm,
          date: periodStart(periodYm),
          type: 'SALARY_ACCRUAL',
          amount: moneyDecimal(salary),
          note: `Monthly salary accrual for ${periodYm}`,
          createdById: runById || null,
          source: 'monthly_accrual',
          sourceRef: `${businessId}:${employee.emp_id}:${periodYm}`,
        },
      })
      await notifyUser({
        userId: entry.userId,
        businessId,
        type: 'SALARY_ADDED',
        priority: 'NORMAL',
        title: 'Salary added to wallet',
        message: `৳ ${salary.toLocaleString('en-BD')} salary was accrued for ${periodYm}.`,
        actionUrl: '/portal',
      })
      enqueueSalaryReceivedSms({
        businessId,
        phone: linked?.phone,
        employeeId: employee.emp_id,
        amount: salary,
        periodYm,
        entryId: entry.id,
      })
      createdCount += 1
    } catch (e) {
      errors.push(`${employee.emp_id}: ${(e as Error).message}`)
      logEvent('error', 'payroll_accrual_employee_failed', { businessId, periodYm, employeeId: employee.emp_id, ...errorMeta(e) })
    }
  }

  const status = errors.length ? (createdCount > 0 ? 'PARTIAL' : 'FAILED') : 'SUCCESS'
  await prisma.payrollAccrualRun.upsert({
    where: { businessId_periodYm: { businessId, periodYm } },
    update: {
      status,
      employeeCount: employees.length,
      createdCount,
      skippedCount,
      error: errors.join('\n') || null,
      runById: runById || null,
      trigger,
      finishedAt: new Date(),
    },
    create: {
      businessId,
      periodYm,
      status,
      employeeCount: employees.length,
      createdCount,
      skippedCount,
      error: errors.join('\n') || null,
      runById: runById || null,
      trigger,
      finishedAt: new Date(),
    },
  })

  if (errors.length) {
    await notifyAdminsFailure(businessId, `Payroll accrual for ${periodYm} finished with ${errors.length} error(s).`)
  }
  logEvent(errors.length ? 'warn' : 'info', 'payroll_accrual_finished', { businessId, periodYm, trigger, employeeCount: employees.length, createdCount, skippedCount, errorCount: errors.length })

  return {
    ok: errors.length === 0,
    businessId,
    periodYm,
    employeeCount: employees.length,
    createdCount,
    skippedCount,
    errors,
  }
}

async function loadAccrualEmployees(businessId: string) {
  try {
    const employeesData = await serverGet<HREmployeesApi>('hr_employees', { business_id: businessId }, 0)
    return (employeesData.employees || [])
      .filter(e => {
        const status = String(e.status || '').toLowerCase()
        return status !== 'inactive' && status !== 'terminated'
      })
      .map(e => ({
        emp_id: e.emp_id,
        email: e.email,
        monthly_salary: Number(e.monthly_salary || 0),
      }))
  } catch {
    const users = await prisma.user.findMany({
      where: {
        active: true,
        role: { not: 'SUPER_ADMIN' },
        employeeIdGas: { not: null },
        businessAccess: { contains: businessId },
      },
      select: { employeeIdGas: true, email: true, salaryHint: true },
    })
    return users.map(u => ({
      emp_id: u.employeeIdGas || '',
      email: u.email,
      monthly_salary: Number(u.salaryHint || 0),
    }))
  }
}
