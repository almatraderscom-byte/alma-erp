import { NextRequest, NextResponse } from 'next/server'
import { getLifestyleCustomers } from '@/lib/lifestyle/read'
import { mirrorCustomerAfterGasWrite } from '@/lib/lifestyle/mirror'
import { serverPost } from '@/lib/server-api'
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
    const result = await serverPost<{ profile_row?: number; ok?: boolean }>('create_customer', await mergeActorPayload(req, raw))
    mirrorCustomerAfterGasWrite(String(raw.id ?? ''))
    return NextResponse.json(result)
  }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }) }
}
