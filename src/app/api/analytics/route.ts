import { NextRequest, NextResponse } from 'next/server'
import { getLifestyleAnalytics } from '@/lib/lifestyle/dashboard'

export async function GET(req: NextRequest) {
  const p = Object.fromEntries(new URL(req.url).searchParams)
  try {
    return NextResponse.json(await getLifestyleAnalytics(p), {
      headers: { 'Cache-Control': 'private, max-age=30, stale-while-revalidate=60' },
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
