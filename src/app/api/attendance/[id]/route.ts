import { NextRequest } from 'next/server'
import { resetAttendanceRecordByAdmin } from '@/lib/attendance-reset'
import { withApiRoute, apiDataSuccess, apiFailure, requireWalletContext } from '@/lib/core/safe-route-helpers'
import { forbidden } from '@/lib/payroll-wallet-access'
import { normalizeAlmaRole } from '@/lib/roles'

export const DELETE = withApiRoute('attendance.reset', async (req: NextRequest, routeCtx?: unknown) => {
  const params = (routeCtx as { params?: { id?: string } })?.params
  const recordId = String(params?.id || '').trim()
  if (!recordId) {
    return apiFailure('invalid_request', 'Attendance record id is required', { status: 400 })
  }

  const auth = await requireWalletContext(req)
  if (!auth.ok) return auth.response
  const { ctx } = auth

  if (normalizeAlmaRole(ctx.role) !== 'SUPER_ADMIN') {
    return forbidden('Only Super Admin can reset attendance records.')
  }

  const result = await resetAttendanceRecordByAdmin(recordId, ctx.userId)
  return apiDataSuccess(result)
})
