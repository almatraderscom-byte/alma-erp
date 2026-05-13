import { NextRequest, NextResponse } from 'next/server'
import { serverGet, serverPost } from '@/lib/server-api'

export async function GET() {
  try { return NextResponse.json(await serverGet('next_invoice_number', {}, 0)) }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }) }
}

export async function POST(req: NextRequest) {
  try { return NextResponse.json(await serverPost('generate_invoice', await req.json())) }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }) }
}
