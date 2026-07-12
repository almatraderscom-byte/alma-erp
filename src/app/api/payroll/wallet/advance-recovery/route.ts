import { NextRequest, NextResponse } from 'next/server'
import { getWalletContext, forbidden } from '@/lib/payroll-wallet-access'
import { manualAdvanceRecovery } from '@/lib/payroll-advance-recovery'

/**
 * POST /api/payroll/wallet/advance-recovery
 * Super admin/HR settles an employee's outstanding advance from their current
 * wallet balance (owner rule 2026-07-11). Body: { employee_id, business_id }.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { employee_id?: string; business_id?: string }
  const ctx = await getWalletContext(req, body.business_id)
  if ('error' in ctx) return ctx.error
  if (!ctx.isAdmin) return forbidden('Only HR/Admin can recover advances.')

  const employeeId = String(body.employee_id || '').trim()
  const businessId = String(body.business_id || '').trim()
  if (!employeeId || !businessId || !(ctx.businessIds as string[]).includes(businessId)) {
    return NextResponse.json({ error: 'employee_id ও business_id দরকার।' }, { status: 400 })
  }

  const result = await manualAdvanceRecovery({ employeeId, businessId, actorUserId: ctx.userId })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
  return NextResponse.json({ ok: true, recovered: result.recovered, remaining: result.remaining, entryId: result.entryId })
}
