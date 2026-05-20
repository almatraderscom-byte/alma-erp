import { NextRequest, NextResponse } from 'next/server'
import { getJwt } from '@/lib/api-guards'
import { getSpotlightAssignment, markSpotlightShown } from '@/lib/operational-tasks'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const token = await getJwt(req)
  if (!token?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const businessId = new URL(req.url).searchParams.get('business_id') || 'ALMA_LIFESTYLE'
  const assignment = await getSpotlightAssignment(token.sub, businessId)
  return NextResponse.json({ assignment })
}

export async function POST(req: NextRequest) {
  const token = await getJwt(req)
  if (!token?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = (await req.json().catch(() => ({}))) as { assignment_id?: string }
  if (!body.assignment_id) {
    return NextResponse.json({ error: 'assignment_id required' }, { status: 400 })
  }
  await markSpotlightShown(body.assignment_id, token.sub)
  return NextResponse.json({ ok: true })
}
