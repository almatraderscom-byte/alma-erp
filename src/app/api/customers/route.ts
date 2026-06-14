import { NextRequest, NextResponse } from 'next/server'
import { getLifestyleCustomers } from '@/lib/lifestyle/read'
import { dispatchCreateCustomer } from '@/lib/lifestyle/write-dispatch'
import { mergeActorPayload } from '@/lib/api-route-actor'
export async function GET(req: NextRequest) {
  const p = Object.fromEntries(new URL(req.url).searchParams)
  try {
    return NextResponse.json(await getLifestyleCustomers(p), { headers: { 'Cache-Control': 's-maxage=60' } })
  } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }) }
}
export async function POST(req: NextRequest) {
  try {
    const raw = (await req.json()) as Record<string, unknown>
    const result = await dispatchCreateCustomer(await mergeActorPayload(req, raw))
    return NextResponse.json(result)
  }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }) }
}
