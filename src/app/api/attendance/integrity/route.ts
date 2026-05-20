import { NextRequest, NextResponse } from 'next/server'
import { getJwt } from '@/lib/api-guards'
import { attendanceDateFor } from '@/lib/attendance'
import { resolveAttendanceBusinessScope } from '@/lib/attendance-business'
import { scanAttendanceIntegrity } from '@/lib/attendance-integrity'
import { normalizeAlmaRole } from '@/lib/roles'
import { isWalletAdmin } from '@/lib/payroll-wallet'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const token = await getJwt(req)
  if (!token?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const role = normalizeAlmaRole(token.role as string)
  if (!isWalletAdmin(role)) {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  }

  const url = new URL(req.url)
  const businessIds = resolveAttendanceBusinessScope(
    String(token.businessAccess || ''),
    url.searchParams.get('business_id'),
    role,
  )
  const report = await scanAttendanceIntegrity(businessIds, attendanceDateFor())
  return NextResponse.json({ ok: true, businessIds, ...report })
}
