import { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 30

import { getJwt } from '@/lib/api-guards'
import { normalizeAlmaRole } from '@/lib/roles'
import { apiFailure, apiDataSuccess } from '@/lib/safe-api-response'
import { withApiRoute } from '@/lib/core/safe-route-helpers'
import { buildAuditTimeline } from '@/lib/audit-timeline'

/**
 * GET /api/audit-timeline — unified "who did what, when, why" activity stream.
 * Owner/admin only. Read-only aggregation of the ERP audit tables (no migration,
 * no write hooks) — see src/lib/audit-timeline.ts.
 */
export const GET = withApiRoute('audit.timeline', async (req: NextRequest) => {
  const token = await getJwt(req)
  if (!token?.sub) return apiFailure('unauthorized', 'Unauthorized', { status: 401 })
  const role = normalizeAlmaRole(token.role as string)
  if (role !== 'SUPER_ADMIN' && role !== 'ADMIN') {
    return apiFailure('forbidden', 'Activity log is owner-only', { status: 403 })
  }

  const { entries, sources } = await buildAuditTimeline()
  return apiDataSuccess({ entries, sources }, { headers: { 'Cache-Control': 'private, no-store' } })
})
