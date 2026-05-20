import { NextRequest } from 'next/server'
import { dispatchApprovalsUpdated } from '@/lib/approvals'
import { repairAllApprovalOrphans, scanApprovalIntegrity } from '@/lib/approval-integrity'
import { withApiRoute, apiDataSuccess, apiFailure, requireJwtRoles } from '@/lib/core/safe-route-helpers'

export const dynamic = 'force-dynamic'

export const GET = withApiRoute('approvals.integrity.scan', async (req: NextRequest) => {
  const auth = await requireJwtRoles(req, ['SUPER_ADMIN'])
  if (!auth.ok) return auth.response

  try {
    const report = await scanApprovalIntegrity(200)
    return apiDataSuccess(report as Record<string, unknown>)
  } catch (e) {
    return apiDataSuccess({
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
})

export const POST = withApiRoute('approvals.integrity.repair', async (req: NextRequest) => {
  const auth = await requireJwtRoles(req, ['SUPER_ADMIN'])
  if (!auth.ok) return auth.response

  try {
    const result = await repairAllApprovalOrphans(String(auth.token.sub), 50)
    dispatchApprovalsUpdated()
    return apiDataSuccess(result as Record<string, unknown>)
  } catch (e) {
    return apiFailure('integrity_repair_failed', (e as Error).message || 'Repair failed', { status: 500 })
  }
})
