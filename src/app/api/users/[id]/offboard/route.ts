import { NextRequest, NextResponse } from 'next/server'
import type { UserRole } from '@prisma/client'
import { getJwt, requireRoles } from '@/lib/api-guards'
import { offboardStaffUser, StaffOffboardingError } from '@/lib/staff-offboarding'

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const denied = await requireRoles(req, ['SUPER_ADMIN', 'ADMIN'])
  if (denied) return denied

  const token = await getJwt(req)
  const { id } = await props.params
  try {
    const body = await req.json().catch(() => ({})) as { reason?: string }
    const result = await offboardStaffUser(id, {
      id: String(token?.sub || ''),
      name: String(token?.name || 'Administrator'),
      role: String(token?.role || 'STAFF') as UserRole,
      businessAccess: String(token?.businessAccess || ''),
    }, { reason: String(body.reason || '').slice(0, 500) })
    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof StaffOffboardingError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    return NextResponse.json({ error: (error as Error).message || 'Offboarding failed' }, { status: 500 })
  }
}
