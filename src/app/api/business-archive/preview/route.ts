import { NextRequest, NextResponse } from 'next/server'
import { getJwt, forbidViewerWrite } from '@/lib/api-guards'
import { normalizeAlmaRole } from '@/lib/roles'
import { buildArchiveConfirmationPhrase } from '@/lib/business-archive/query'
import { runArchivePreview } from '@/lib/business-archive/service'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const denied = await forbidViewerWrite(req)
  if (denied) return denied
  const token = await getJwt(req)
  if (!token?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (normalizeAlmaRole(token.role as string) !== 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = (await req.json().catch(() => ({}))) as {
    business_id?: string
    module_keys?: string[]
  }

  const businessId = String(body.business_id || '').trim()
  const moduleKeys = Array.isArray(body.module_keys) ? body.module_keys : []
  if (!businessId || !moduleKeys.length) {
    return NextResponse.json({ error: 'business_id and module_keys required' }, { status: 400 })
  }

  try {
    const preview = await runArchivePreview(businessId, moduleKeys)
    const confirmationPhrase = buildArchiveConfirmationPhrase(businessId, moduleKeys)
    return NextResponse.json({ preview, confirmationPhrase })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}
