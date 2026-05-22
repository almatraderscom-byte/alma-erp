import { NextRequest, NextResponse } from 'next/server'
import { serverGet, serverPost } from '@/lib/server-api'
import { mergeActorPayload } from '@/lib/api-route-actor'
import { sendPayrollAlert } from '@/lib/resend'
import { prisma } from '@/lib/prisma'
import { getJwt } from '@/lib/api-guards'
import { businessAllowed, parseBusinessAccess } from '@/lib/business-access'
import type { HREmployeesApi } from '@/types/hr'

export async function GET(req: NextRequest) {
  const p = Object.fromEntries(new URL(req.url).searchParams)
  try {
    const data = await serverGet<HREmployeesApi>('hr_employees', p, 0)
    if (p.include_users === '1') {
      const users = await linkedEmployeeUsers(req, String(p.business_id || 'ALMA_LIFESTYLE'), data)
      if ('error' in users) return users.error
      return NextResponse.json({ ...data, users }, { headers: { 'Cache-Control': 'private, no-store' } })
    }
    return NextResponse.json(data, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const userId = String((body as Record<string, unknown>).user_id || '').trim()
    const businessId = String((body as Record<string, unknown>).business_id || 'ALMA_LIFESTYLE')
    if (userId) {
      const duplicate = await validateEmployeeUserLink(userId, String((body as Record<string, unknown>).emp_id || ''), businessId)
      if (duplicate) return duplicate
    }
    const result = await serverPost('hr_employee_save', await mergeActorPayload(req, body as Record<string, unknown>))
    const empId = String((result as { emp_id?: string }).emp_id || (body as { emp_id?: string }).emp_id || '').trim()
    if (userId && empId) {
      const existingLink = await prisma.user.findFirst({
        where: { employeeIdGas: empId, NOT: { id: userId } },
        select: { id: true, name: true },
      })
      if (existingLink) {
        return NextResponse.json({ error: `Employee ID ${empId} is already linked to ${existingLink.name}.` }, { status: 409 })
      }
      await prisma.user.update({
        where: { id: userId },
        data: {
          employeeIdGas: empId,
          salaryHint: Number((body as { monthly_salary?: number }).monthly_salary || 0) || null,
          joiningDate: (body as { joining_date?: string }).joining_date ? new Date((body as { joining_date: string }).joining_date) : undefined,
        },
      })
    }
    await sendPayrollAlert({
      businessId: String(body.business_id || 'ALMA_LIFESTYLE'),
      subject: `Employee added/updated · ${String(body.name || (result as { emp_id?: string }).emp_id || '')}`,
      title: 'Employee added',
      preview: `${String(body.name || 'Employee')} was saved in HR.`,
      text: `${String(body.name || 'Employee')} was saved in HR. Employee ID: ${String((result as { emp_id?: string }).emp_id || body.emp_id || '')}.`,
      priority: 'NORMAL',
      actionUrl: '/employees',
      actionLabel: 'Open employees',
      dedupeKey: `employee-save:${String((result as { emp_id?: string }).emp_id || body.emp_id || Date.now())}:${String(body.updated_at || '')}`,
      metadata: { result, body },
    })
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

async function linkedEmployeeUsers(req: NextRequest, businessId: string, roster: HREmployeesApi) {
  const token = await getJwt(req)
  if (!token?.sub) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  if (!businessAllowed(token.businessAccess as string, businessId)) {
    return { error: NextResponse.json({ error: 'Business not permitted for this user.' }, { status: 403 }) }
  }

  const employeesById = new Map(roster.employees.map(e => [e.emp_id, e]))
  const employeeIds = new Set(roster.employees.map(e => e.emp_id))
  const users = await prisma.user.findMany({
    where: {
      active: true,
      role: { not: 'SUPER_ADMIN' },
      businessAccess: { contains: businessId },
      ...(process.env.NODE_ENV === 'production' && process.env.ENABLE_DEMO_USERS !== 'true'
        ? {
            AND: [
              { OR: [{ email: null }, { NOT: { email: { endsWith: '@alma-erp.demo' } } }] },
              { OR: [{ phone: null }, { NOT: { phone: { startsWith: '+880170000000' } } }] },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      role: true,
      businessAccess: true,
      employeeIdGas: true,
      salaryHint: true,
      joiningDate: true,
    },
  })

  return users.map(user => {
    const matchedByExistingLink = user.employeeIdGas ? employeesById.get(user.employeeIdGas) : undefined
    const matchedByContact = roster.employees.find(e => {
      const emailMatch = user.email && e.email && user.email.toLowerCase() === e.email.toLowerCase()
      const phoneMatch = user.phone && e.phone && user.phone.replace(/\D/g, '') === e.phone.replace(/\D/g, '')
      return emailMatch || phoneMatch
    })
    const suggested = matchedByExistingLink || matchedByContact
    const linked = Boolean(user.employeeIdGas && employeeIds.has(user.employeeIdGas))
    const orphanEmployeeId =
      user.employeeIdGas && !employeeIds.has(user.employeeIdGas) ? user.employeeIdGas : null
    return {
      ...user,
      businesses: parseBusinessAccess(user.businessAccess),
      linked,
      linkState: linked ? ('linked' as const) : orphanEmployeeId ? ('orphan' as const) : ('unlinked' as const),
      linkedEmployeeId: user.employeeIdGas || null,
      orphanEmployeeId,
      matchedEmployeeId: suggested?.emp_id || null,
      matchedEmployeeName: suggested?.name || null,
      selectable: !linked,
    }
  })
}

async function validateEmployeeUserLink(userId: string, requestedEmpId: string, businessId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, role: true, businessAccess: true, employeeIdGas: true },
  })
  if (!user) return NextResponse.json({ error: 'Selected user not found.' }, { status: 404 })
  if (user.role === 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'System owner accounts do not use HR employee links.' }, { status: 400 })
  }
  if (!businessAllowed(user.businessAccess, businessId)) {
    return NextResponse.json({ error: 'Selected user does not have access to this business.' }, { status: 400 })
  }
  if (user.employeeIdGas && (!requestedEmpId || user.employeeIdGas !== requestedEmpId)) {
    return NextResponse.json({ error: `${user.name} is already linked to employee ${user.employeeIdGas}.` }, { status: 409 })
  }
  if (requestedEmpId) {
    const linked = await prisma.user.findFirst({
      where: { employeeIdGas: requestedEmpId, role: { not: 'SUPER_ADMIN' }, NOT: { id: userId } },
      select: { name: true },
    })
    if (linked) return NextResponse.json({ error: `Employee ID ${requestedEmpId} is already linked to ${linked.name}.` }, { status: 409 })
  }
  return null
}
