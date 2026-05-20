import { NextRequest, NextResponse } from 'next/server'
import { getJwt } from '@/lib/api-guards'
import { normalizeAlmaRole } from '@/lib/roles'
import { getArchiveStats, modulesForBusiness } from '@/lib/business-archive/service'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const token = await getJwt(req)
  if (!token?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (normalizeAlmaRole(token.role as string) !== 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const businessId = new URL(req.url).searchParams.get('business_id') || 'ALMA_LIFESTYLE'
  const modules = modulesForBusiness(businessId)
  const stats = await getArchiveStats(businessId)

  return NextResponse.json({ businessId, modules, stats })
}
