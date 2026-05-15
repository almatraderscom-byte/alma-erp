import { NextRequest, NextResponse } from 'next/server'
import { INVOICE_SERVER_TIMEOUT_MS, serverPost } from '@/lib/server-api'
import { withActorPayload } from '@/lib/api-route-actor'

export const maxDuration = 75

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const data = await serverPost<{ ok?: boolean; pdf_url?: string; error?: string }>(
      'cdit_generate_invoice_pdf',
      withActorPayload(req, body as Record<string, unknown>),
      { timeoutMs: INVOICE_SERVER_TIMEOUT_MS },
    )
    if (data && data.ok === false) {
      return NextResponse.json({ error: data.error || 'PDF generation failed' }, { status: 400 })
    }
    return NextResponse.json(data)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
