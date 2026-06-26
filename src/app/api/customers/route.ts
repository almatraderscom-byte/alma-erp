import { NextRequest, NextResponse } from 'next/server'
import { getLifestyleCustomers } from '@/lib/lifestyle/read'
import { dispatchCreateCustomer } from '@/lib/lifestyle/write-dispatch'
import { mergeActorPayload } from '@/lib/api-route-actor'
import { logEvent } from '@/lib/logger'
import { apiFailure } from '@/lib/safe-api-response'
export async function GET(req: NextRequest) {
  const p = Object.fromEntries(new URL(req.url).searchParams)
  try {
    return NextResponse.json(await getLifestyleCustomers(p), { headers: { 'Cache-Control': 's-maxage=60' } })
  } catch (e) {
    logEvent('error', 'customers.read_failed', { error: (e as Error).message })
    return apiFailure('server_error', 'Could not load customers.', { status: 500 })
  }
}
export async function POST(req: NextRequest) {
  try {
    const raw = (await req.json()) as Record<string, unknown>
    const result = await dispatchCreateCustomer(await mergeActorPayload(req, raw))
    return NextResponse.json(result)
  }
  catch (e) {
    logEvent('error', 'customers.create_failed', { error: (e as Error).message })
    return apiFailure('server_error', 'Could not save the customer.', { status: 500 })
  }
}
