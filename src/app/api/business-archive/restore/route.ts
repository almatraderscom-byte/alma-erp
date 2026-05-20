import { NextRequest } from 'next/server'
import { runArchiveRestore } from '@/lib/business-archive/service'
import { withApiRoute, apiDataSuccess, apiFailure, requireJwtRoles, guardViewerWrite, parseJsonBody } from '@/lib/core/safe-route-helpers'

export const dynamic = 'force-dynamic'

export const POST = withApiRoute('archive.restore', async (req: NextRequest) => {
  const write = await guardViewerWrite(req)
  if (!write.ok) return write.response
  const auth = await requireJwtRoles(req, ['SUPER_ADMIN'])
  if (!auth.ok) return auth.response

  const body = await parseJsonBody<{ batch_id?: string }>(req)
  if (!body.batch_id) {
    return apiFailure('invalid_request', 'batch_id required', { status: 400 })
  }

  try {
    const result = await runArchiveRestore(body.batch_id, String(auth.token.sub))
    return apiDataSuccess(result as Record<string, unknown>)
  } catch (e) {
    return apiFailure('archive_restore_failed', (e as Error).message, { status: 400 })
  }
})
