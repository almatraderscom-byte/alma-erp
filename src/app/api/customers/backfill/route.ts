import { NextRequest, NextResponse } from 'next/server'
import { serverPost } from '@/lib/server-api'
import { mergeActorPayload } from '@/lib/api-route-actor'
import { requireJwtRoles } from '@/lib/core/safe-route-helpers'

export async function POST(req: NextRequest) {
  const auth = await requireJwtRoles(req, ['SUPER_ADMIN'])
  if (!auth.ok) return auth.response

  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const url = new URL(req.url)
    const businessId = String(body.business_id || url.searchParams.get('business_id') || 'ALMA_LIFESTYLE')
    const payload = await mergeActorPayload(req, { ...body, business_id: businessId })
    const result = await serverPost<{
      ok?: boolean
      error?: string
      processed?: number
      created?: number
      skipped?: number
      errors?: number
    }>('admin_backfill_crm', payload, { timeoutMs: 120_000 })

    if (result.error && result.ok === false) {
      return NextResponse.json({ error: result.error }, { status: 400 })
    }

    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
