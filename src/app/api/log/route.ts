import { NextRequest, NextResponse } from 'next/server'
import { serverGet } from '@/lib/server-api'
export async function GET(req: NextRequest) {
  const limit = new URL(req.url).searchParams.get('limit') ?? '100'
  try { return NextResponse.json(await serverGet('log', { limit }, 0)) }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }) }
}
