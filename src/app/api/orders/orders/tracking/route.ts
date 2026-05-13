import { NextRequest, NextResponse } from 'next/server'
import { serverPost } from '@/lib/server-api'
export async function POST(req: NextRequest) {
  try {
    const { id, tracking_id, courier } = await req.json()
    if (!id || !tracking_id) return NextResponse.json({ error: 'id and tracking_id required' }, { status: 400 })
    return NextResponse.json(await serverPost('update_tracking', { id, tracking_id, courier }))
  } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }) }
}
