import { NextRequest, NextResponse } from 'next/server'
import { serverGet, serverPost } from '@/lib/server-api'
import { mergeActorPayload } from '@/lib/api-route-actor'
import { sendFinanceAlert } from '@/lib/resend'
import { prisma } from '@/lib/prisma'

export const revalidate = 0

export async function GET(req: NextRequest) {
  const p = Object.fromEntries(new URL(req.url).searchParams)
  try {
    return NextResponse.json(await serverGet('finance', p, 0), {
      headers: { 'Cache-Control': 'private, no-store' },
    })
  }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }) }
}

export async function POST(req: NextRequest) {
  try {
    const raw = (await req.json()) as Record<string, unknown>
    const result = await serverPost('add_expense', await mergeActorPayload(req, raw))
    const attachmentId = String(raw.receipt_attachment_id || '').trim()
    const expenseId = String((result as { expense_id?: string; exp_id?: string }).expense_id || (result as { exp_id?: string }).exp_id || '')
    if (attachmentId && expenseId) {
      await prisma.expenseAttachment.updateMany({
        where: { id: attachmentId, deletedAt: null },
        data: { expenseId },
      })
    }
    await sendFinanceAlert({
      businessId: String(raw.business_id || 'ALMA_LIFESTYLE'),
      subject: `Expense added · ৳${Number(raw.amount || 0).toLocaleString('en-BD')}`,
      title: 'Expense added',
      preview: `${String(raw.category || 'Expense')} · ৳${Number(raw.amount || 0).toLocaleString('en-BD')}`,
      text: `Expense added: ${String(raw.category || 'Expense')} for ৳${Number(raw.amount || 0).toLocaleString('en-BD')}.`,
      priority: 'NORMAL',
      actionUrl: '/finance',
      actionLabel: 'Open finance',
      dedupeKey: `expense-added:${String((result as { expense_id?: string }).expense_id || Date.now())}`,
      metadata: { result, raw },
    })
    return NextResponse.json(result)
  }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }) }
}
