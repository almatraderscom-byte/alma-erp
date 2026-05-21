import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getJwt, requireRoles } from '@/lib/api-guards'
import { isSystemOwner, type AlmaRole } from '@/lib/roles'
import { isValidBdPhone, normalizeBdPhone } from '@/lib/phone'

function canAssignRole(actor: AlmaRole, target: UserRole): boolean {
  if (actor === 'SUPER_ADMIN') return true
  if (actor === 'ADMIN') return target !== 'SUPER_ADMIN'
  return false
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const denied = await requireRoles(req, ['SUPER_ADMIN', 'ADMIN'])
  if (denied) return denied

  const token = await getJwt(req)
  const actorRole = String(token?.role || '') as AlmaRole

  try {
    const body = (await req.json()) as Partial<{
      name: string
      email: string | null
      phone: string
      role: UserRole
      businessAccess: string
      employeeIdGas: string | null
      active: boolean
      salaryHint: number | null
      joiningDate: string | null
      profileImageUrl: string | null
    }>

    const existing = await prisma.user.findUnique({ where: { id: params.id } })
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (existing.role === 'SUPER_ADMIN' && actorRole !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Only Super Admin can modify a Super Admin account' }, { status: 403 })
    }

    if (body.role && !canAssignRole(actorRole, body.role)) {
      return NextResponse.json({ error: 'Cannot assign this role' }, { status: 403 })
    }
    const targetRole = body.role ?? existing.role
    const systemOwner = isSystemOwner(targetRole)
    const phone = body.phone !== undefined ? normalizeBdPhone(body.phone) : undefined
    if (phone !== undefined && phone && !isValidBdPhone(phone)) {
      return NextResponse.json({ error: 'Enter a valid Bangladesh phone number.' }, { status: 400 })
    }

    await prisma.user.update({
      where: { id: params.id },
      data: {
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        ...(body.email !== undefined ? { email: body.email?.trim().toLowerCase() || null } : {}),
        ...(body.phone !== undefined ? { phone: phone || null } : {}),
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.businessAccess !== undefined ? { businessAccess: body.businessAccess.trim() } : {}),
        ...(systemOwner ? { employeeIdGas: null } : body.employeeIdGas !== undefined ? { employeeIdGas: body.employeeIdGas } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
        ...(body.profileImageUrl !== undefined ? { profileImageUrl: body.profileImageUrl } : {}),
        ...(systemOwner ? { salaryHint: null } : body.salaryHint !== undefined ? { salaryHint: body.salaryHint } : {}),
        ...(systemOwner
          ? { joiningDate: null }
          : body.joiningDate !== undefined
          ? { joiningDate: body.joiningDate ? new Date(body.joiningDate) : null }
          : {}),
      },
    })

    return NextResponse.json({ ok: true })
  } catch (e) {
    const msg = (e as Error).message
    if (msg.includes('Unique constraint')) return NextResponse.json({ error: 'Phone or email already exists' }, { status: 400 })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
