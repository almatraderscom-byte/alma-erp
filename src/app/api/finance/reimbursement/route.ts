import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { prisma } from '@/lib/prisma'
import { roundMoney } from '@/lib/money'
import { logEvent } from '@/lib/logger'
import { apiFailure } from '@/lib/safe-api-response'
import { resolveMyDeskProfile } from '@/lib/profile-resolution'
import { APPROVAL_MODULES, APPROVAL_TYPES } from '@/lib/approval-types'
import { enqueueReimbursementClaim } from '@/lib/staff-reimbursement'

export const revalidate = 0
export const runtime = 'nodejs'

const LIFESTYLE_BUSINESS_ID = 'ALMA_LIFESTYLE'

type ClaimRow = {
  id: string
  amount: number
  category: string
  note: string | null
  expenseDate: string | null
  hasReceipt: boolean
  status: string
  createdAt: string
  resolvedAt: string | null
}

/** GET → the signed-in staffer's own reimbursement claims (newest first). */
export async function GET(req: NextRequest) {
  try {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
    if (!token?.sub) return apiFailure('unauthorized', 'Login required.', { status: 401 })

    const businessId = new URL(req.url).searchParams.get('business_id') || LIFESTYLE_BUSINESS_ID
    const rows = await prisma.approvalRequest.findMany({
      where: {
        module: APPROVAL_MODULES.FINANCE,
        type: APPROVAL_TYPES.EXPENSE_REIMBURSEMENT,
        requestedBy: token.sub,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        status: true,
        reason: true,
        payloadSnapshot: true,
        createdAt: true,
        approvedAt: true,
        rejectedAt: true,
      },
    })

    const claims: ClaimRow[] = rows.map((r) => {
      const snap = (r.payloadSnapshot && typeof r.payloadSnapshot === 'object'
        ? (r.payloadSnapshot as Record<string, unknown>)
        : {}) as Record<string, unknown>
      return {
        id: r.id,
        amount: roundMoney(Number(snap.reimburse_amount || snap.amount || 0)),
        category: String(snap.category || 'Reimbursement'),
        note: snap.note ? String(snap.note) : null,
        expenseDate: snap.date ? String(snap.date) : null,
        hasReceipt: Boolean(snap.receipt_attachment_id),
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        resolvedAt: (r.approvedAt || r.rejectedAt)?.toISOString() || null,
      }
    })

    const pendingTotal = roundMoney(
      claims.filter((c) => c.status === 'PENDING').reduce((s, c) => s + c.amount, 0),
    )

    return NextResponse.json(
      { ok: true, businessId, claims, pendingTotal },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  } catch (e) {
    logEvent('error', 'reimbursement.read_failed', { error: (e as Error).message })
    return apiFailure('server_error', 'Could not load your claims.', { status: 500 })
  }
}

/**
 * POST → a staffer files an own-pocket expense claim. Any logged-in user with a
 * linked employee id can submit; it goes to the owner's approval center and only
 * credits the wallet on approval. Add-only — no edit/delete here.
 */
export async function POST(req: NextRequest) {
  try {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
    if (!token?.sub) return apiFailure('unauthorized', 'Login required.', { status: 401 })

    const raw = (await req.json()) as Record<string, unknown>
    const businessId = String(raw.business_id || LIFESTYLE_BUSINESS_ID)

    const profile = await resolveMyDeskProfile(token.sub, businessId)
    const employeeId = String(profile?.employeeIdGas || '').trim()
    if (!employeeId) {
      return apiFailure(
        'no_employee_link',
        'আপনার অ্যাকাউন্টে কর্মী আইডি যুক্ত নেই — ম্যানেজারকে বলুন Users-এ লিংক করতে, তারপর ফেরতের আবেদন করুন।',
        { status: 400 },
      )
    }

    // Batch (items[]) or legacy single-claim body — one approval per item so the
    // owner can approve/reject each expense independently in the approval center.
    const rawItems: Record<string, unknown>[] = Array.isArray(raw.items)
      ? (raw.items as Record<string, unknown>[])
      : [raw]
    if (rawItems.length < 1) {
      return apiFailure('no_items', 'অন্তত একটি খরচ দিন।', { status: 400 })
    }
    if (rawItems.length > 20) {
      return apiFailure('too_many_items', 'একসাথে সর্বোচ্চ ২০টি খরচ জমা দেওয়া যায়।', { status: 400 })
    }

    const parsed = rawItems.map((item) => ({
      amount: roundMoney(Number(String(item.amount ?? '').toString().replace(/[^0-9.]/g, ''))),
      category: String(item.category || '').trim() || 'Reimbursement',
      note: item.note ? String(item.note).slice(0, 500) : null,
      vendor: item.vendor ? String(item.vendor) : null,
      expenseDate: item.expense_date ? String(item.expense_date) : null,
      receiptRef: item.receipt_ref ? String(item.receipt_ref) : null,
      receiptAttachmentId: item.receipt_attachment_id ? String(item.receipt_attachment_id) : null,
    }))
    if (parsed.some((p) => !(p.amount > 0))) {
      return apiFailure('bad_amount', 'প্রতিটি খরচে সঠিক টাকার অঙ্ক দিন।', { status: 400 })
    }

    const actorName = String(profile?.name || token.name || token.email || 'Staff')
    const approvalIds: string[] = []
    for (const p of parsed) {
      const approval = await enqueueReimbursementClaim({
        businessId,
        employeeId,
        userId: token.sub,
        actorName,
        ...p,
      })
      approvalIds.push(approval.id)
    }

    const total = roundMoney(parsed.reduce((s, p) => s + p.amount, 0))
    return NextResponse.json({
      ok: true,
      approvalId: approvalIds[0],
      approvalIds,
      count: approvalIds.length,
      message: approvalIds.length > 1
        ? `${approvalIds.length}টি খরচ (মোট ৳${total.toLocaleString('en-BD')}) একসাথে পাঠানো হয়েছে। মালিক অনুমোদন করলে টাকা পাবেন।`
        : `৳${total.toLocaleString('en-BD')} ফেরতের আবেদন পাঠানো হয়েছে। মালিক অনুমোদন করলে আপনার ওয়ালেটে যোগ হবে।`,
    })
  } catch (e) {
    logEvent('error', 'reimbursement.create_failed', { error: (e as Error).message })
    return apiFailure('server_error', 'আবেদন পাঠানো যায়নি।', { status: 500 })
  }
}
