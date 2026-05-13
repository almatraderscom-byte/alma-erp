import { NextRequest, NextResponse } from 'next/server'
import { serverGet, serverPost } from '@/lib/server-api'

export const revalidate = 60

export async function GET() {
  try { return NextResponse.json(await serverGet('finance', {}, 60)) }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }) }
}

export async function POST(req: NextRequest) {
  try { return NextResponse.json(await serverPost('add_expense', await req.json())) }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }) }
}
