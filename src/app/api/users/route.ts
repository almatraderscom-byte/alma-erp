import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getJwt, requireRoles } from '@/lib/api-guards'
import { isSystemOwner, normalizeAlmaRole, type AlmaRole } from '@/lib/roles'
import { isValidBdPhone, normalizeBdPhone } from '@/lib/phone'
import { BUSINESS_LIST } from '@/lib/businesses'
import { normalizeBusinessAccessForRole } from '@/lib/business-access'
import { serverGet } from '@/lib/server-api'
import type { HREmployeesApi } from '@/types/hr'
import { resolveProfileImageForUser } from '@/lib/user-display'

function canAssignRole(actor: AlmaRole, target: UserRole): boolean {
  if (actor === 'SUPER_ADMIN') return true
  if (actor === 'ADMIN') return target !== 'SUPER_ADMIN'
  return false
}

const VALID_BUSINESS_IDS = new Set<string>(BUSINESS_LIST.map(b => b.id))

function parseBusinessAccess(raw: string | null | undefined) {
  return String(raw || '')
    .split(',')
    .map(s => s.trim())
    .filter(id => VALID_BUSINESS_IDS.has(id))
}

function normalizeBusinessAccess(raw: string | null | undefined, fallback: string) {
  const ids = parseBusinessAccess(raw)
  return (ids.length ? ids : parseBusinessAccess(fallback)).join(',')
}

function phoneKey(value: string | null | undefined) {
  return String(value || '').replace(/\D/g, '')
}

function nonDemoUserWhere() {
  return {
    AND: [
      { OR: [{ email: null }, { NOT: { email: { endsWith: '@alma-erp.demo' } } }] },
      { OR: [{ phone: null }, { NOT: { phone: { startsWith: '+880170000000' } } }] },
    ],
  }
}

export async function GET(req: NextRequest) {
  const denied = await requireRoles(req, ['SUPER_ADMIN', 'ADMIN'])
  if (denied) return denied

  const token = await getJwt(req)
  const actorRole = normalizeAlmaRole(token?.role as string)
  const actorBusinessIds = parseBusinessAccess(token?.businessAccess as string)
  const hideDemoUsers = process.env.NODE_ENV === 'production' && process.env.ENABLE_DEMO_USERS !== 'true'
  const users = await prisma.user.findMany({
    where: {
      ...(hideDemoUsers ? nonDemoUserWhere() : {}),
      ...(actorRole === 'SUPER_ADMIN' || !actorBusinessIds.length
        ? {}
        : {
            OR: actorBusinessIds.map(id => ({ businessAccess: { contains: id } })),
          }),
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      email: true,
      name: true,
      phone: true,
      role: true,
      active: true,
      businessAccess: true,
      employeeIdGas: true,
      joiningDate: true,
      salaryHint: true,
      profileImageUrl: true,
      updatedAt: true,
      createdAt: true,
    },
  })

  return NextResponse.json({
    users: users.map(user => ({
      ...user,
      profileImageUrl: resolveProfileImageForUser(user),
    })),
  })
}

export async function POST(req: NextRequest) {
  const denied = await requireRoles(req, ['SUPER_ADMIN', 'ADMIN'])
  if (denied) return denied

  const token = await getJwt(req)
  const actorRole = normalizeAlmaRole(token?.role as string)

  try {
    const body = (await req.json()) as {
      email?: string
      name?: string
      password?: string
      phone?: string
      role?: UserRole
      businessAccess?: string
      employeeIdGas?: string | null
      active?: boolean
      joiningDate?: string | null
      salaryHint?: number | null
      profileImageUrl?: string | null
    }
    const email = String(body.email || '').trim().toLowerCase() || null
    const phone = normalizeBdPhone(body.phone)
    const name = String(body.name || '').trim()
    const password = String(body.password || '')
    const role = (body.role || 'STAFF') as UserRole

    if (!phone || !isValidBdPhone(phone) || !name || !password || password.length < 8) {
      return NextResponse.json({ error: 'valid Bangladesh phone, name, password (8+ chars) required' }, { status: 400 })
    }

    if (!canAssignRole(actorRole, role)) {
      return NextResponse.json({ error: 'Cannot assign this role' }, { status: 403 })
    }

    const actorBusinessAccess = normalizeBusinessAccessForRole(String(token?.businessAccess || ''), actorRole)
    const actorBusinessIds = parseBusinessAccess(actorBusinessAccess)
    const businessAccess = normalizeBusinessAccessForRole(normalizeBusinessAccess(body.businessAccess, actorBusinessAccess), role)
    const targetBusinessIds = parseBusinessAccess(businessAccess)
    if (actorRole !== 'SUPER_ADMIN' && targetBusinessIds.some(id => !actorBusinessIds.includes(id))) {
      return NextResponse.json({ error: 'Cannot assign business access outside your scope' }, { status: 403 })
    }

    const systemOwner = isSystemOwner(role)
    const employeeIdGas = systemOwner
      ? null
      : await resolveEmployeeLink({
          requestedEmployeeId: body.employeeIdGas,
          businessIds: targetBusinessIds,
          email,
          phone,
        })

    const passwordHash = await bcrypt.hash(password, 12)
    const user = await prisma.user.create({
      data: {
        email,
        name,
        passwordHash,
        phone,
        role,
        businessAccess,
        employeeIdGas,
        active: body.active !== false,
        joiningDate: systemOwner ? null : body.joiningDate ? new Date(body.joiningDate) : null,
        salaryHint: systemOwner ? null : body.salaryHint ?? null,
        profileImageUrl: body.profileImageUrl || null,
      },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        role: true,
        active: true,
        businessAccess: true,
        employeeIdGas: true,
        joiningDate: true,
        salaryHint: true,
        profileImageUrl: true,
        createdAt: true,
      },
    })

    return NextResponse.json({ ok: true, user })
  } catch (e) {
    const msg = (e as Error).message
    if (msg.includes('Unique constraint')) {
      return NextResponse.json({ error: 'Phone or email already exists' }, { status: 400 })
    }
    if (msg.includes('already linked')) {
      return NextResponse.json({ error: msg }, { status: 409 })
    }
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

async function resolveEmployeeLink({
  requestedEmployeeId,
  businessIds,
  email,
  phone,
}: {
  requestedEmployeeId?: string | null
  businessIds: string[]
  email: string | null
  phone: string | null
}) {
  const requested = String(requestedEmployeeId || '').trim()
  if (requested) {
    const linked = await prisma.user.findFirst({
      where: { employeeIdGas: requested, role: { not: 'SUPER_ADMIN' } },
      select: { name: true },
    })
    if (linked) throw new Error(`Employee ID ${requested} is already linked to ${linked.name}.`)
    return requested
  }

  for (const businessId of businessIds) {
    try {
      const roster = await serverGet<HREmployeesApi>('hr_employees', { business_id: businessId }, 0)
      const match = roster.employees.find(employee => {
        const emailMatch = email && employee.email && employee.email.toLowerCase() === email
        const phoneMatch = phone && employee.phone && phoneKey(employee.phone) === phoneKey(phone)
        return emailMatch || phoneMatch
      })
      if (!match?.emp_id) continue

      const linked = await prisma.user.findFirst({
        where: { employeeIdGas: match.emp_id, role: { not: 'SUPER_ADMIN' } },
        select: { id: true },
      })
      if (!linked) return match.emp_id
    } catch {
      /* GAS roster can be unavailable during account creation; keep login creation independent. */
    }
  }

  return null
}
