import { NextRequest, NextResponse } from 'next/server'
import { serverApi } from '@/lib/server-api'

export async function GET(req: NextRequest) {
  const p = Object.fromEntries(new URL(req.url).searchParams)
  try {
    return NextResponse.json(await serverApi.get('customers', p, 60), { headers: { 'Cache-Control': 's-maxage=60' } })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    return NextResponse.json(await serverApi.post('create_customer', await req.json()))
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
