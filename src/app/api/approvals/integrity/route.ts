import { NextRequest, NextResponse } from 'next/server'
import { getJwt } from '@/lib/api-guards'
import { normalizeAlmaRole } from '@/lib/roles'
import { dispatchApprovalsUpdated } from '@/lib/approvals'
import { repairAllApprovalOrphans, scanApprovalIntegrity } from '@/lib/approval-integrity'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const token = await getJwt(req)
  if (!token?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const role = normalizeAlmaRole(token.role as string)
  if (role !== 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'Super Admin only' }, { status: 403 })
  }

  const report = await scanApprovalIntegrity(200)
  return NextResponse.json({ ok: true, ...report })
}

export async function POST(req: NextRequest) {
  const token = await getJwt(req)
  if (!token?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const role = normalizeAlmaRole(token.role as string)
  if (role !== 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'Super Admin only' }, { status: 403 })
  }

  const result = await repairAllApprovalOrphans(token.sub, 50)
  dispatchApprovalsUpdated()
  return NextResponse.json({ ok: true, ...result })
}
