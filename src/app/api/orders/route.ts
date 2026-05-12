import { NextRequest, NextResponse } from 'next/server'
import { serverApi } from '@/lib/server-api'

export async function GET(req: NextRequest) {
  const p = Object.fromEntries(new URL(req.url).searchParams)
  try {
    const data = await serverApi.get('orders', p, 30)
    return NextResponse.json(data, { headers: { 'Cache-Control': 's-maxage=30, stale-while-revalidate=60' } })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    return NextResponse.json(await serverApi.post('create_order', body))
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
