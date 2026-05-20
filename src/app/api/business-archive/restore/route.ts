import { NextRequest, NextResponse } from 'next/server'
import { getJwt, forbidViewerWrite } from '@/lib/api-guards'
import { normalizeAlmaRole } from '@/lib/roles'
import { runArchiveRestore } from '@/lib/business-archive/service'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const denied = await forbidViewerWrite(req)
  if (denied) return denied
  const token = await getJwt(req)
  if (!token?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (normalizeAlmaRole(token.role as string) !== 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = (await req.json().catch(() => ({}))) as { batch_id?: string }
  if (!body.batch_id) {
    return NextResponse.json({ error: 'batch_id required' }, { status: 400 })
  }

  try {
    const result = await runArchiveRestore(body.batch_id, token.sub)
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}
