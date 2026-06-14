import { NextRequest, NextResponse } from 'next/server'
import { serverGet } from '@/lib/server-api'
import { getLifestyleOrder } from '@/lib/lifestyle/read'
import { parseShareSlug } from '@/lib/pdf/format'
import type { CditInvoice, CditPayment } from '@/types/cdit'
import type { BusinessBranding } from '@/types/branding'
import { prisma } from '@/lib/prisma'

export async function GET(
  _req: NextRequest,
  { params }: { params: { slug: string } },
) {
  const parsed = parseShareSlug(params.slug)
  if (!parsed) return NextResponse.json({ error: 'invalid slug' }, { status: 400 })

  try {
    if (parsed.type === 'alma') {
      const orderRes = await getLifestyleOrder(parsed.id, { business_id: 'ALMA_LIFESTYLE' })
      if ('error' in orderRes && orderRes.error) {
        return NextResponse.json({ error: 'order not found' }, { status: 404 })
      }
      if (!orderRes.order) {
        return NextResponse.json({ error: 'order not found' }, { status: 404 })
      }
      const branding = await serverGet<{ branding: BusinessBranding }>(
        'branding',
        { business_id: 'ALMA_LIFESTYLE' },
        0,
      )
      return NextResponse.json({
        type: 'alma',
        order: orderRes.order,
        invoice: await prisma.invoiceRecord.findFirst({
          where: { orderId: parsed.id, businessId: 'ALMA_LIFESTYLE', deletedAt: null },
          select: { invoiceNumber: true, paymentStatus: true },
        }),
        branding: branding.branding,
      }, { headers: { 'Cache-Control': 'private, no-store, must-revalidate' } })
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
    }, { headers: { 'Cache-Control': 'private, no-store, must-revalidate' } })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
