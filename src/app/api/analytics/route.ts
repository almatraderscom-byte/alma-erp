import { NextRequest, NextResponse } from 'next/server'
import { getLifestyleAnalytics } from '@/lib/lifestyle/dashboard'

export const revalidate = 0

export async function GET(req: NextRequest) {
  const p = Object.fromEntries(new URL(req.url).searchParams)
  try {
    return NextResponse.json(await getLifestyleAnalytics(p), {
      headers: { 'Cache-Control': 'private, no-store' },
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
