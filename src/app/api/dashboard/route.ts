import { NextRequest, NextResponse } from 'next/server'
import { getLifestyleDashboard } from '@/lib/lifestyle/dashboard'

export async function GET(req: NextRequest) {
  const p = Object.fromEntries(new URL(req.url).searchParams)
  try {
    const data = await getLifestyleDashboard(p)
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'private, max-age=15, stale-while-revalidate=30' },
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
