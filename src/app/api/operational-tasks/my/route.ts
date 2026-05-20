import { NextRequest, NextResponse } from 'next/server'
import { getJwt } from '@/lib/api-guards'
import { listMyActiveTasks } from '@/lib/operational-tasks'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const token = await getJwt(req)
  if (!token?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const businessId = new URL(req.url).searchParams.get('business_id') || 'ALMA_LIFESTYLE'
  const tasks = await listMyActiveTasks(token.sub, businessId)
  return NextResponse.json({ tasks })
}
