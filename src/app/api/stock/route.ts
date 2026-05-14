import { NextResponse } from 'next/server'
import { serverGet } from '@/lib/server-api'

export async function GET() {
  try {
    const data = await serverGet('stock', {}, 0)
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'private, no-store, must-revalidate' },
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
