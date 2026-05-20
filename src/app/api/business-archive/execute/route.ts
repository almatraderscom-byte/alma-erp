import { NextRequest, NextResponse } from 'next/server'
import { getJwt, forbidViewerWrite } from '@/lib/api-guards'
import { normalizeAlmaRole } from '@/lib/roles'
import { runArchiveExecute } from '@/lib/business-archive/service'

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
    batch_name?: string
    confirmation?: string
  }

  try {
    const result = await runArchiveExecute({
      businessId: String(body.business_id || ''),
      moduleKeys: Array.isArray(body.module_keys) ? body.module_keys : [],
      batchName: String(body.batch_name || ''),
      confirmation: String(body.confirmation || ''),
      actorUserId: token.sub,
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}
