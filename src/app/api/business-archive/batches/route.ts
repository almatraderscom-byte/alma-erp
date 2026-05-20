import { NextRequest, NextResponse } from 'next/server'
import { getJwt } from '@/lib/api-guards'
import { normalizeAlmaRole } from '@/lib/roles'
import { logEvent } from '@/lib/logger'
import { listArchiveAudit, listArchiveBatches } from '@/lib/business-archive/service'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const token = await getJwt(req)
  if (!token?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (normalizeAlmaRole(token.role as string) !== 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const businessId = new URL(req.url).searchParams.get('business_id') || undefined

  try {
    const batches = await listArchiveBatches(businessId)
    const audit = businessId ? await listArchiveAudit(businessId) : []
    return NextResponse.json({ ok: true, batches, audit })
  } catch (err) {
    logEvent('warn', 'archive.registry.warning', {
      businessId,
      message: (err as Error).message,
    })
    return NextResponse.json({
      ok: false,
      batches: [],
      audit: [],
      warning: (err as Error).message,
    })
  }
}
