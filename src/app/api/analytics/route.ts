import { NextRequest, NextResponse } from 'next/server'
import { serverGet } from '@/lib/server-api'

export const revalidate = 0

export async function GET(req: NextRequest) {
  const p = Object.fromEntries(new URL(req.url).searchParams)
  try {
    return NextResponse.json(await serverGet('analytics', p, 0), {
      headers: { 'Cache-Control': 'private, no-store' },
    })
  }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }) }
}
