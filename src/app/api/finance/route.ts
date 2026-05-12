import { NextResponse } from 'next/server'
import { serverApi } from '@/lib/server-api'
export const revalidate = 60
export async function GET() {
  try { return NextResponse.json(await serverApi.get('finance', {}, 60)) }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }) }
}
