import { NextRequest, NextResponse } from 'next/server'
import { getJwt } from '@/lib/api-guards'
import { normalizeAlmaRole } from '@/lib/roles'
import { dispatchApprovalsUpdated } from '@/lib/approvals'
import { repairAllApprovalOrphans, scanApprovalIntegrity } from '@/lib/approval-integrity'
import { apiFailure, apiSuccess } from '@/lib/safe-api-response'
import { logEvent } from '@/lib/logger'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    const token = await getJwt(req)
    if (!token?.sub) return apiFailure('unauthorized', 'Unauthorized', { status: 401 })
    const role = normalizeAlmaRole(token.role as string)
    if (role !== 'SUPER_ADMIN') {
      return apiFailure('forbidden', 'Super Admin only', { status: 403 })
    }

    const report = await scanApprovalIntegrity(200)
    return apiSuccess(report)
  } catch (e) {
    logEvent('warn', 'approval.api.failed', { route: 'integrity.scan', message: (e as Error).message })
    return apiSuccess({
      scanned: 0,
      pendingWaivers: 0,
      walletOrphans: [],
      penaltyApprovalOrphans: [],
      penaltyWaiverOrphans: [],
      orphans: [],
      warning: (e as Error).message || 'Integrity scan unavailable',
      partialFailure: true,
    })
  }
}

export async function POST(req: NextRequest) {
  try {
    const token = await getJwt(req)
    if (!token?.sub) return apiFailure('unauthorized', 'Unauthorized', { status: 401 })
    const role = normalizeAlmaRole(token.role as string)
    if (role !== 'SUPER_ADMIN') {
      return apiFailure('forbidden', 'Super Admin only', { status: 403 })
    }

    const result = await repairAllApprovalOrphans(token.sub, 50)
    dispatchApprovalsUpdated()
    return apiSuccess(result)
  } catch (e) {
    logEvent('error', 'approval.api.failed', { route: 'integrity.repair', message: (e as Error).message })
    return apiFailure('integrity_repair_failed', (e as Error).message || 'Repair failed', { status: 500 })
  }
}
