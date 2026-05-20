import { NextRequest, NextResponse } from 'next/server'
import { getJwt } from '@/lib/api-guards'
import { normalizeAlmaRole } from '@/lib/roles'
import { loadTaskSpotlightAssignees } from '@/lib/operational-task-assignees'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const token = await getJwt(req)
  if (!token?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (normalizeAlmaRole(token.role as string) !== 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const businessId = new URL(req.url).searchParams.get('business_id')?.trim()
  if (!businessId) {
    return NextResponse.json({ error: 'business_id is required' }, { status: 400 })
  }

  const employees = await loadTaskSpotlightAssignees(businessId, token.sub)

  return NextResponse.json({
    businessId,
    employees: employees.map(e => ({
      id: e.id,
      name: e.name,
      email: e.email,
      role: e.role,
      employeeIdGas: e.employeeIdGas,
    })),
    count: employees.length,
  })
}
