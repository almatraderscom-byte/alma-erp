import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { prisma } from '@/lib/prisma'
import { logEvent } from '@/lib/logger'
import { apiFailure } from '@/lib/safe-api-response'
import { can, normalizeAlmaRole } from '@/lib/roles'
import { resolveMyDeskProfile } from '@/lib/profile-resolution'
import { enqueueReimbursementClaim } from '@/lib/staff-reimbursement'
import { notifyRoles } from '@/lib/notifications'
import { NOTIFY_ROLES } from '@/lib/notification-routing'
import { APPROVAL_MODULES, APPROVAL_TYPES } from '@/lib/approval-types'

export const revalidate = 0
export const runtime = 'nodejs'

const LIFESTYLE_BUSINESS_ID = 'ALMA_LIFESTYLE'

/**
 * POST → settle a বাকি (Pending/Partial) expense (owner directive 2026-09-01).
 * Body: { expense_id, business_id?, paid_by: 'company' | 'self', payment_method? }
 *
 * - company: bookkeeping — the row was already owner-approved when it was added, so
 *   any expenseWrite role flips it to Paid directly (owner gets a notification).
 * - self (staff): money moves → routed through the EXPENSE_REIMBURSEMENT approval
 *   with existing_expense_id, so ONE owner approve flips the row to Paid/Own pocket
 *   AND credits the staffer's wallet. Super Admin self settles directly, no wallet.
 *
 * Lifestyle ledger only (LifestyleExpense) — trading has its own account wallets.
 */
export async function POST(req: NextRequest) {
  try {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
    if (!token?.sub) return apiFailure('unauthorized', 'Login required.', { status: 401 })
    const role = normalizeAlmaRole(token.role as string)
    const actorName = String(token.name || token.email || 'Staff')

    const raw = (await req.json()) as Record<string, unknown>
    const expenseRef = String(raw.expense_id || '').trim()
    const paidBy = String(raw.paid_by || '').trim().toLowerCase()
    const method = String(raw.payment_method || '').trim().slice(0, 80)
    if (!expenseRef) return apiFailure('bad_request', 'expense_id required.', { status: 400 })
    if (paidBy !== 'company' && paidBy !== 'self') {
      return apiFailure('bad_request', "paid_by must be 'company' or 'self'.", { status: 400 })
    }

    // The ledger's exp_id is legacySheetId when the row came from the GAS backfill.
    const expense = await prisma.lifestyleExpense.findFirst({
      where: { OR: [{ id: expenseRef }, { legacySheetId: expenseRef }], deletedAt: null },
    })
    if (!expense) {
      return apiFailure('not_found', 'খরচটি পাওয়া যায়নি (এখন শুধু Lifestyle লেজারে কাজ করে)।', { status: 404 })
    }
    if (expense.paymentStatus === 'Paid' || expense.paymentStatus === 'Reimbursed') {
      return apiFailure('already_paid', 'এই খরচ আগেই পরিশোধ হয়েছে।', { status: 400 })
    }
    const businessId = expense.businessId || String(raw.business_id || LIFESTYLE_BUSINESS_ID)

    if (paidBy === 'company' || role === 'SUPER_ADMIN') {
      if (!can(role, 'expenseWrite')) {
        return apiFailure('forbidden', 'বাকি পরিশোধ চিহ্নিত করার অনুমতি নেই।', { status: 403 })
      }
      const paymentMethod = paidBy === 'self' ? 'Own pocket' : (method || expense.paymentMethod || '')
      await prisma.lifestyleExpense.update({
        where: { id: expense.id },
        data: { paymentStatus: 'Paid', paymentMethod },
      })
      void notifyRoles(NOTIFY_ROLES.expenseAdded, {
        businessId,
        type: 'EXPENSE_ADDED',
        priority: 'NORMAL',
        title: 'বাকি খরচ পরিশোধ',
        message: `${actorName} · ${expense.title || expense.category} · ৳${expense.amount.toLocaleString('en-BD')} পরিশোধ চিহ্নিত`,
        actionUrl: '/expenses',
      }).catch(() => {})
      return NextResponse.json({ ok: true, paid: true, message: 'পরিশোধ চিহ্নিত করা হয়েছে।' })
    }

    // Staff paid the pending bill from their own pocket → owner approval + wallet credit.
    const dupe = await prisma.approvalRequest.findFirst({
      where: {
        module: APPROVAL_MODULES.FINANCE,
        type: APPROVAL_TYPES.EXPENSE_REIMBURSEMENT,
        status: 'PENDING',
        payloadSnapshot: { path: ['existing_expense_id'], equals: expense.id },
      },
      select: { id: true },
    })
    if (dupe) {
      return apiFailure('duplicate', 'এই খরচের জন্য আগেই একটি আবেদন অনুমোদনের অপেক্ষায় আছে।', { status: 400 })
    }
    const profile = await resolveMyDeskProfile(token.sub, businessId)
    const employeeId = String(profile?.employeeIdGas || '').trim()
    if (!employeeId) {
      return apiFailure(
        'no_employee_link',
        'আপনার অ্যাকাউন্টে কর্মী আইডি যুক্ত নেই — ম্যানেজারকে বলুন Users-এ লিংক করতে, তারপর আবার চেষ্টা করুন।',
        { status: 400 },
      )
    }
    const approval = await enqueueReimbursementClaim({
      businessId,
      employeeId,
      userId: token.sub,
      actorName: String(profile?.name || actorName),
      amount: expense.amount,
      category: expense.category,
      title: expense.title || null,
      note: `বাকি খরচ নিজ পকেটে পরিশোধ${expense.title ? ` · ${expense.title}` : ''}`,
      existingExpenseId: expense.id,
    })
    return NextResponse.json({
      ok: true,
      pending_approval: true,
      approval_id: approval.id,
      message: 'আবেদন পাঠানো হয়েছে। মালিক অনুমোদন করলে খরচটি পরিশোধ হবে এবং টাকা আপনার ওয়ালেটে যোগ হবে।',
    })
  } catch (e) {
    logEvent('error', 'finance.mark_paid_failed', { error: (e as Error).message })
    return apiFailure('server_error', 'পরিশোধ চিহ্নিত করা যায়নি।', { status: 500 })
  }
}
