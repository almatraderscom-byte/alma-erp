import { NextRequest, NextResponse } from 'next/server'
import { serverApi } from '@/lib/server-api'
export async function GET(req: NextRequest) {
  const limit = new URL(req.url).searchParams.get('limit') ?? '50'
  try { return NextResponse.json(await serverApi.get('log', { limit }, 30)) }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }) }
}
