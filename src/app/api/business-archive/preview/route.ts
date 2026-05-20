import { NextRequest } from 'next/server'
import { buildArchiveConfirmationPhrase } from '@/lib/business-archive/query'
import { runArchivePreview } from '@/lib/business-archive/service'
import { withApiRoute, apiDataSuccess, apiFailure, requireJwtRoles, guardViewerWrite, parseJsonBody } from '@/lib/core/safe-route-helpers'

export const dynamic = 'force-dynamic'

export const POST = withApiRoute('archive.preview', async (req: NextRequest) => {
  const write = await guardViewerWrite(req)
  if (!write.ok) return write.response
  const auth = await requireJwtRoles(req, ['SUPER_ADMIN'])
  if (!auth.ok) return auth.response

  const body = await parseJsonBody<{ business_id?: string; module_keys?: string[] }>(req)
  const businessId = String(body.business_id || '').trim()
  const moduleKeys = Array.isArray(body.module_keys) ? body.module_keys : []
  if (!businessId || !moduleKeys.length) {
    return apiFailure('invalid_request', 'business_id and module_keys required', { status: 400 })
  }

  try {
    const preview = await runArchivePreview(businessId, moduleKeys)
    const confirmationPhrase = buildArchiveConfirmationPhrase(businessId, moduleKeys)
    return apiDataSuccess({ preview, confirmationPhrase })
  } catch (e) {
    return apiDataSuccess({
      preview: null,
      confirmationPhrase: null,
      warning: (e as Error).message,
      partialFailure: true,
    })
  }
})
