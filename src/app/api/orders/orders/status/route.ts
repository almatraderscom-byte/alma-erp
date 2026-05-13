import { NextRequest, NextResponse } from 'next/server'
import { serverPost } from '@/lib/server-api'
export async function POST(req: NextRequest) {
  try {
    const { id, status } = await req.json()
    if (!id || !status) return NextResponse.json({ error: 'id and status required' }, { status: 400 })
    return NextResponse.json(await serverPost('update_status', { id, status }))
  } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }) }
}
