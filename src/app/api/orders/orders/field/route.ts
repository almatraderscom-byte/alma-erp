import { NextRequest, NextResponse } from 'next/server'
import { serverPost } from '@/lib/server-api'
export async function POST(req: NextRequest) {
  try {
    const { id, field, value } = await req.json()
    if (!id || !field || value === undefined)
      return NextResponse.json({ error: 'id, field, value required' }, { status: 400 })
    return NextResponse.json(await serverPost('update_field', { id, field, value }))
  } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }) }
}
