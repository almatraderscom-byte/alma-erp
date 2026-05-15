import { NextRequest, NextResponse } from 'next/server'
import { serverGet } from '@/lib/server-api'
import { parseShareSlug } from '@/lib/pdf/format'
import type { Order } from '@/types'
import type { CditInvoice, CditPayment } from '@/types/cdit'
import type { BusinessBranding } from '@/types/branding'

export async function GET(
  _req: NextRequest,
  { params }: { params: { slug: string } },
) {
  const parsed = parseShareSlug(params.slug)
  if (!parsed) return NextResponse.json({ error: 'invalid slug' }, { status: 400 })

  try {
    if (parsed.type === 'alma') {
      const orderRes = await serverGet<{ order?: Order; error?: string }>('order', { id: parsed.id }, 0)
      if ((orderRes as { error?: string }).error || !(orderRes as { order?: Order }).order) {
        return NextResponse.json({ error: 'order not found' }, { status: 404 })
      }
      const branding = await serverGet<{ branding: BusinessBranding }>(
        'branding',
        { business_id: 'ALMA_LIFESTYLE' },
        0,
      )
      return NextResponse.json({
        type: 'alma',
        order: (orderRes as { order: Order }).order,
        branding: branding.branding,
      })
    }

    const [invRes, payRes, brandRes] = await Promise.all([
      serverGet<{ invoices: CditInvoice[] }>('cdit_invoices', {}, 0),
      serverGet<{ payments: CditPayment[] }>('cdit_payments', {}, 0),
      serverGet<{ branding: BusinessBranding }>('branding', { business_id: 'CREATIVE_DIGITAL_IT' }, 0),
    ])
    const invoice = invRes.invoices.find(i => i.id === parsed.id)
    if (!invoice) return NextResponse.json({ error: 'invoice not found' }, { status: 404 })
    const payments = payRes.payments.filter(p => p.invoice_id === parsed.id)
    return NextResponse.json({
      type: 'cdit',
      invoice,
      payments,
      branding: brandRes.branding,
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
