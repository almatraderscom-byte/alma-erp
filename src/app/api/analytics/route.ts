import { NextResponse } from 'next/server'
import { serverGet } from '@/lib/server-api'
export const revalidate = 60
export async function GET() {
  try { return NextResponse.json(await serverGet('analytics')) }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }) }
}
