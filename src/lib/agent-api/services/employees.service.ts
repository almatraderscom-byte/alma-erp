import { serverGet, serverPost } from '@/lib/server-api'
import { prisma } from '@/lib/prisma'
import { DEFAULT_AGENT_BUSINESS_ID } from '@/lib/agent-api/constants'
import { agentActorPayload } from '@/lib/agent-api/route-handler'
import type { HREmployee, HREmployeesApi } from '@/types/hr'
import type { AgentEmployee } from '@/lib/agent-api/schemas/employees.schema'
import { todayYmdDhaka, daysAgoYmd } from '@/lib/agent-api/dhaka-date'

/** GAS hr_employees columns: emp_id, name, phone, email, role, joining_date, monthly_salary, status */
function mapEmployee(row: HREmployee, telegramId?: string | null): AgentEmployee {
  const active = String(row.status || '').toLowerCase() !== 'inactive'
  const joined = row.joining_date
    ? new Date(`${row.joining_date.slice(0, 10)}T00:00:00+06:00`).toISOString()
    : new Date().toISOString()
  return {
    id: row.emp_id,
    name: row.name,
    role: row.role || null,
    phone: row.phone || null,
    active,
    joinedAt: joined,
    telegramId: telegramId ?? null,
  }
}

async function telegramByEmpId(businessId: string): Promise<Map<string, string>> {
  const links = await prisma.tradingTelegramUser.findMany({
    where: { businessId, approved: true, userId: { not: null } },
    include: { user: { select: { employeeIdGas: true } } },
  })
  const map = new Map<string, string>()
  for (const l of links) {
    const emp = l.user?.employeeIdGas
    if (emp) map.set(emp, l.telegramUserId)
  }
  return map
}

export async function listEmployees(input: {
  active?: boolean
  limit?: number
  search?: string
}) {
  const limit = input.limit ?? 50
  const data = await serverGet<HREmployeesApi>('hr_employees', {
    business_id: DEFAULT_AGENT_BUSINESS_ID,
  }, 0)
  const tg = await telegramByEmpId(DEFAULT_AGENT_BUSINESS_ID)
  let rows = data.employees ?? []
  if (input.active === true) rows = rows.filter(e => String(e.status).toLowerCase() !== 'inactive')
  if (input.active === false) rows = rows.filter(e => String(e.status).toLowerCase() === 'inactive')
  if (input.search?.trim()) {
    const q = input.search.trim().toLowerCase()
    rows = rows.filter(
      e =>
        e.name.toLowerCase().includes(q) ||
        e.phone?.includes(q) ||
        e.emp_id.toLowerCase().includes(q),
    )
  }
  const employees = rows.slice(0, limit).map(e => mapEmployee(e, tg.get(e.emp_id)))
  return {
    employees,
    meta: { count: rows.length, limit, active: input.active ?? null, search: input.search ?? null },
  }
}

export async function getEmployee(id: string) {
  const { employees } = await listEmployees({ limit: 500 })
  const found = employees.find(e => e.id === id)
  if (!found) return null

  const monthStart = daysAgoYmd(30)
  const records = await prisma.attendanceRecord.findMany({
    where: {
      businessId: DEFAULT_AGENT_BUSINESS_ID,
      employeeId: id,
      isArchived: false,
      attendanceDate: { gte: new Date(`${monthStart}T00:00:00+06:00`) },
    },
  })
  const presentDays = records.length
  const lateDays = records.filter(r => r.lateMinutes > 0).length

  const pendingTasksCount = await prisma.operationalTaskAssignment.count({
    where: {
      user: { employeeIdGas: id },
      status: { in: ['ACTIVE', 'IN_PROGRESS', 'ACKNOWLEDGED'] },
    },
  })

  const monthYm = todayYmdDhaka().slice(0, 7)
  const fines = await prisma.employeeLedgerEntry.aggregate({
    where: {
      employeeId: id,
      businessId: DEFAULT_AGENT_BUSINESS_ID,
      type: 'PENALTY',
      periodYm: monthYm,
      isArchived: false,
    },
    _sum: { amount: true },
  })

  return {
    ...found,
    recentAttendance: { presentDays, absentDays: 0, lateDays },
    pendingTasksCount,
    totalFinesThisMonth: Number(fines._sum.amount ?? 0),
  }
}

export async function createEmployee(body: Record<string, unknown>) {
  const result = await serverPost<{ emp_id?: string; ok?: boolean }>(
    'hr_employee_save',
    agentActorPayload({ business_id: DEFAULT_AGENT_BUSINESS_ID, ...body }),
  )
  const id = String(result.emp_id ?? '')
  return { id, status: 'created', createdAt: new Date().toISOString() }
}

export async function patchEmployee(id: string, body: Record<string, unknown>) {
  await serverPost(
    'hr_employee_save',
    agentActorPayload({ business_id: DEFAULT_AGENT_BUSINESS_ID, emp_id: id, ...body }),
  )
  return { id, status: 'updated', updatedAt: new Date().toISOString() }
}

export async function softDeleteEmployee(id: string) {
  await serverPost(
    'hr_employee_save',
    agentActorPayload({
      business_id: DEFAULT_AGENT_BUSINESS_ID,
      emp_id: id,
      status: 'inactive',
    }),
  )
  return { id, status: 'deactivated' }
}
