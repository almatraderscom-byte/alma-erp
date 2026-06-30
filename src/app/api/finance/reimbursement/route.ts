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

    const amount = roundMoney(Number(String(raw.amount ?? '').toString().replace(/[^0-9.]/g, '')))
    if (!(amount > 0)) {
      return apiFailure('bad_amount', 'সঠিক একটি টাকার অঙ্ক দিন।', { status: 400 })
    }
    const category = String(raw.category || '').trim() || 'Reimbursement'
    const note = raw.note ? String(raw.note).slice(0, 500) : null

    const approval = await enqueueReimbursementClaim({
      businessId,
      employeeId,
      userId: token.sub,
      actorName: String(profile?.name || token.name || token.email || 'Staff'),
      amount,
      category,
      note,
      vendor: raw.vendor ? String(raw.vendor) : null,
      receiptRef: raw.receipt_ref ? String(raw.receipt_ref) : null,
      receiptAttachmentId: raw.receipt_attachment_id ? String(raw.receipt_attachment_id) : null,
    })

    return NextResponse.json({
      ok: true,
      approvalId: approval.id,
      message: `৳${amount.toLocaleString('en-BD')} ফেরতের আবেদন পাঠানো হয়েছে। মালিক অনুমোদন করলে আপনার ওয়ালেটে যোগ হবে।`,
    })
  } catch (e) {
    logEvent('error', 'reimbursement.create_failed', { error: (e as Error).message })
    return apiFailure('server_error', 'আবেদন পাঠানো যায়নি।', { status: 500 })
  }
}
