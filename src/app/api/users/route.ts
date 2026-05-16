import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getJwt, requireRoles } from '@/lib/api-guards'
import type { AlmaRole } from '@/lib/roles'
import { isValidBdPhone, normalizeBdPhone } from '@/lib/phone'

function canAssignRole(actor: AlmaRole, target: UserRole): boolean {
  if (actor === 'SUPER_ADMIN') return true
  if (actor === 'ADMIN') return target !== 'SUPER_ADMIN'
  return false
}

export async function GET(req: NextRequest) {
  const denied = await requireRoles(req, ['SUPER_ADMIN', 'ADMIN'])
  if (denied) return denied

  const hideDemoUsers = process.env.NODE_ENV === 'production' && process.env.ENABLE_DEMO_USERS !== 'true'
  const users = await prisma.user.findMany({
    where: hideDemoUsers ? { NOT: { email: { endsWith: '@alma-erp.demo' } } } : undefined,
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
      createdAt: true,
    },
  })

  return NextResponse.json({ users })
}

export async function POST(req: NextRequest) {
  const denied = await requireRoles(req, ['SUPER_ADMIN', 'ADMIN'])
  if (denied) return denied

  const token = await getJwt(req)
  const actorRole = String(token?.role || '') as AlmaRole

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

    const passwordHash = await bcrypt.hash(password, 12)
    const user = await prisma.user.create({
      data: {
        email,
        name,
        passwordHash,
        phone,
        role,
        businessAccess: body.businessAccess?.trim() || 'ALMA_LIFESTYLE,CREATIVE_DIGITAL_IT',
        employeeIdGas: body.employeeIdGas || null,
        active: body.active !== false,
      },
      select: { id: true, email: true, phone: true },
    })

    return NextResponse.json({ ok: true, user })
  } catch (e) {
    const msg = (e as Error).message
    if (msg.includes('Unique constraint')) {
      return NextResponse.json({ error: 'Phone or email already exists' }, { status: 400 })
    }
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
