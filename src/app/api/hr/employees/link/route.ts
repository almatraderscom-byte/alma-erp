import { NextRequest, NextResponse } from 'next/server'
import { getJwt } from '@/lib/api-guards'
import { businessAllowed } from '@/lib/business-access'
import { prisma } from '@/lib/prisma'
import { serverGet } from '@/lib/server-api'
import type { HREmployeesApi } from '@/types/hr'

type LinkBody =
  | { action: 'clear_user_link'; user_id: string; business_id: string }
  | { action: 'link_user_to_employee'; user_id: string; employee_id: string; business_id: string }

export async function PATCH(req: NextRequest) {
  const token = await getJwt(req)
  if (!token?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: LinkBody
  try {
    body = (await req.json()) as LinkBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const businessId = String(body.business_id || '').trim()
  const userId = String(body.user_id || '').trim()
  if (!businessId || !userId) {
    return NextResponse.json({ error: 'business_id and user_id are required.' }, { status: 400 })
  }
  if (!businessAllowed(token.businessAccess as string, businessId)) {
    return NextResponse.json({ error: 'Business not permitted for this user.' }, { status: 403 })
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, role: true, businessAccess: true, employeeIdGas: true },
  })
  if (!user) return NextResponse.json({ error: 'User not found.' }, { status: 404 })
  if (user.role === 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'System owner accounts do not use HR employee links.' }, { status: 400 })
  }
  if (!businessAllowed(user.businessAccess, businessId)) {
    return NextResponse.json({ error: 'User does not have access to this business.' }, { status: 400 })
  }

  if (body.action === 'clear_user_link') {
    await prisma.user.update({ where: { id: userId }, data: { employeeIdGas: null } })
    return NextResponse.json({ ok: true, userId, employeeIdGas: null })
  }

  if (body.action === 'link_user_to_employee') {
    const employeeId = String(body.employee_id || '').trim()
    if (!employeeId) return NextResponse.json({ error: 'employee_id is required.' }, { status: 400 })

    const roster = await serverGet<HREmployeesApi>('hr_employees', { business_id: businessId }, 0)
    if (!roster.employees.some(e => e.emp_id === employeeId)) {
      return NextResponse.json({ error: `Employee ${employeeId} is not in the current roster.` }, { status: 400 })
    }

    const conflict = await prisma.user.findFirst({
      where: { employeeIdGas: employeeId, NOT: { id: userId }, role: { not: 'SUPER_ADMIN' } },
      select: { name: true },
    })
    if (conflict) {
      return NextResponse.json({ error: `Employee ID ${employeeId} is already linked to ${conflict.name}.` }, { status: 409 })
    }

    await prisma.user.update({ where: { id: userId }, data: { employeeIdGas: employeeId } })
    return NextResponse.json({ ok: true, userId, employeeIdGas: employeeId })
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
