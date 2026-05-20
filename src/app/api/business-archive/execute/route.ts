import { NextRequest } from 'next/server'
import { runArchiveExecute } from '@/lib/business-archive/service'
import { withApiRoute, apiDataSuccess, apiFailure, requireJwtRoles, guardViewerWrite, parseJsonBody } from '@/lib/core/safe-route-helpers'

export const dynamic = 'force-dynamic'

export const POST = withApiRoute('archive.execute', async (req: NextRequest) => {
  const write = await guardViewerWrite(req)
  if (!write.ok) return write.response
  const auth = await requireJwtRoles(req, ['SUPER_ADMIN'])
  if (!auth.ok) return auth.response

  const body = await parseJsonBody<{
    business_id?: string
    module_keys?: string[]
    batch_name?: string
    confirmation?: string
  }>(req)

  try {
    const result = await runArchiveExecute({
      businessId: String(body.business_id || ''),
      moduleKeys: Array.isArray(body.module_keys) ? body.module_keys : [],
      batchName: String(body.batch_name || ''),
      confirmation: String(body.confirmation || ''),
      actorUserId: String(auth.token.sub),
    })
    return apiDataSuccess(result as Record<string, unknown>)
  } catch (e) {
    return apiFailure('archive_execute_failed', (e as Error).message, { status: 400 })
  }
})
