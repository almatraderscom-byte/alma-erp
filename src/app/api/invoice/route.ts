import { NextRequest, NextResponse } from 'next/server'
import { serverApi } from '@/lib/server-api'
export async function POST(req: NextRequest) {
  try { return NextResponse.json(await serverApi.post('generate_invoice', await req.json())) }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }) }
}
