import { NextRequest, NextResponse } from 'next/server'
import { serverApi } from '@/lib/server-api'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const { status } = await req.json()
    return NextResponse.json(await serverApi.post('update_status', { id: params.id, status }))
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
