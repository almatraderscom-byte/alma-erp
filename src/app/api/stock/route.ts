import { NextResponse } from 'next/server'
import { serverApi } from '@/lib/server-api'
export const revalidate = 120
export async function GET() {
  try { return NextResponse.json(await serverApi.get('stock', {}, 120)) }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }) }
}
