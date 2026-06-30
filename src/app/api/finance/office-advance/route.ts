import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { parseMoneyInput } from '@/lib/money'
import { logEvent } from '@/lib/logger'
import { apiFailure } from '@/lib/safe-api-response'
import { normalizeAlmaRole } from '@/lib/roles'
import { resolveMyDeskProfile } from '@/lib/profile-resolution'
import { OFFICE_FUND_BUSINESS_ID, computeOfficeFundSummary } from '@/lib/office-fund'
import {
  enqueueOfficeAdvanceRequest,
  enqueueOfficeAdvanceReconcile,
  listOfficeAdvancesForUser,
  getOutstandingAdvancesForUser,
  type LeftoverMethod,
} from '@/lib/office-advance'

export const revalidate = 0
export const runtime = 'nodejs'

function isAdmin(role: string): boolean {
  return role === 'SUPER_ADMIN' || role === 'ADMIN'
}

/** GET → the signed-in admin's office advances + outstanding total + fund balance. */
export async function GET(req: NextRequest) {
  try {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
    if (!token?.sub) return apiFailure('unauthorized', 'Login required.', { status: 401 })
    const role = normalizeAlmaRole(token.role as string)
    if (!isAdmin(role)) {
      return apiFailure('forbidden', 'অফিস অ্যাডভান্স শুধু অ্যাডমিনদের জন্য।', { status: 403 })
    }

    const businessId = new URL(req.url).searchParams.get('business_id') || OFFICE_FUND_BUSINESS_ID
    const [advances, outstanding, fund] = await Promise.all([
      listOfficeAdvancesForUser(token.sub, businessId, 50),
      getOutstandingAdvancesForUser(token.sub, businessId),
      computeOfficeFundSummary(businessId),
    ])

    return NextResponse.json(
      {
        ok: true,
        businessId,
        advances,
        outstanding: { count: outstanding.count, total: outstanding.total },
        fundBalance: fund.balance,
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  } catch (e) {
    logEvent('error', 'office_advance.read_failed', { error: (e as Error).message })
    return apiFailure('server_error', 'অ্যাডভান্স লোড করা যায়নি।', { status: 500 })
  }
}

/** POST → an admin requests an office-fund advance. Admin / Super Admin only. */
export async function POST(req: NextRequest) {
  try {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
    if (!token?.sub) return apiFailure('unauthorized', 'Login required.', { status: 401 })
    const role = normalizeAlmaRole(token.role as string)
    if (!isAdmin(role)) {
      return apiFailure('forbidden', 'শুধু অ্যাডমিন অফিস অ্যাডভান্স নিতে পারেন।', { status: 403 })
    }

    const raw = (await req.json()) as Record<string, unknown>
    const businessId = String(raw.business_id || OFFICE_FUND_BUSINESS_ID)

    const profile = await resolveMyDeskProfile(token.sub, businessId)
    const employeeId = String(profile?.employeeIdGas || '').trim()
    if (!employeeId) {
      return apiFailure(
        'no_employee_link',
        'আপনার অ্যাকাউন্টে কর্মী আইডি যুক্ত নেই — Users-এ লিংক করার পর অ্যাডভান্স নিন।',
        { status: 400 },
      )
    }

    const amount = parseMoneyInput(raw.amount as string | number | undefined)
    if (!(amount > 0)) {
      return apiFailure('bad_amount', 'সঠিক একটি টাকার অঙ্ক দিন।', { status: 400 })
    }

    // Don't let an advance exceed what is actually in the fund.
    const fund = await computeOfficeFundSummary(businessId)
    if (amount > fund.balance) {
      return apiFailure(
        'insufficient_fund',
        `ফান্ডে যথেষ্ট টাকা নেই। বর্তমান ব্যালেন্স: ৳${fund.balance.toLocaleString('en-BD')}।`,
        { status: 400 },
      )
    }

    const purpose = raw.purpose ? String(raw.purpose).slice(0, 500) : null
    const payoutMethod = raw.payout_method ? String(raw.payout_method).slice(0, 60) : null
    const payoutNumber = raw.payout_number ? String(raw.payout_number).slice(0, 60) : null
    if (!payoutNumber) {
      return apiFailure('no_payout_number', 'টাকা কোথায় পাঠাবেন সেই বিকাশ/ওয়ালেট নম্বর দিন।', { status: 400 })
    }

    const { advance, approval } = await enqueueOfficeAdvanceRequest({
      businessId,
      employeeId,
      userId: token.sub,
      requestedByName: String(profile?.name || token.name || token.email || 'Admin'),
      amount,
      purpose,
      payoutMethod,
      payoutNumber,
    })

    return NextResponse.json({
      ok: true,
      advanceId: advance.id,
      approvalId: approval.id,
      message: `৳${amount.toLocaleString('en-BD')} অফিস অ্যাডভান্সের আবেদন পাঠানো হয়েছে। মালিক অনুমোদন করলে টাকা ${payoutMethod || 'আপনার নম্বরে'} পাঠানো হবে।`,
    })
  } catch (e) {
    logEvent('error', 'office_advance.create_failed', { error: (e as Error).message })
    return apiFailure('server_error', 'অ্যাডভান্সের আবেদন পাঠানো যায়নি।', { status: 500 })
  }
}

/** PATCH → an admin reconciles one of their OUTSTANDING advances (spent + leftover). */
export async function PATCH(req: NextRequest) {
  try {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
    if (!token?.sub) return apiFailure('unauthorized', 'Login required.', { status: 401 })
    const role = normalizeAlmaRole(token.role as string)
    if (!isAdmin(role)) {
      return apiFailure('forbidden', 'শুধু অ্যাডমিন হিসাব দিতে পারেন।', { status: 403 })
    }

    const raw = (await req.json()) as Record<string, unknown>
    const advanceId = String(raw.advance_id || '').trim()
    if (!advanceId) return apiFailure('no_advance', 'কোন অ্যাডভান্সের হিসাব দিচ্ছেন তা জানান।', { status: 400 })

    const spent = parseMoneyInput(raw.spent as string | number | undefined)
    if (spent < 0) return apiFailure('bad_spent', 'সঠিক খরচের অঙ্ক দিন।', { status: 400 })

    const leftoverMethod: LeftoverMethod =
      String(raw.leftover_method || '') === 'WALLET_DEDUCT' ? 'WALLET_DEDUCT' : 'CASH_RETURN'

    const profile = await resolveMyDeskProfile(token.sub, OFFICE_FUND_BUSINESS_ID)
    const actorName = String(profile?.name || token.name || token.email || 'Admin')

    try {
      const { approval, leftover } = await enqueueOfficeAdvanceReconcile({
        advanceId,
        userId: token.sub,
        actorName,
        spent,
        leftoverMethod,
        category: raw.category ? String(raw.category) : null,
        note: raw.note ? String(raw.note) : null,
      })
      const leftoverLine =
        leftover > 0
          ? ` বাকি ৳${leftover.toLocaleString('en-BD')} ${leftoverMethod === 'WALLET_DEDUCT' ? 'আপনার ওয়ালেট থেকে কাটা হবে' : 'ক্যাশ ফেরত দেবেন'}।`
          : ''
      return NextResponse.json({
        ok: true,
        approvalId: approval.id,
        message: `হিসাব পাঠানো হয়েছে — মালিকের অনুমোদনের অপেক্ষায়।${leftoverLine}`,
      })
    } catch (err) {
      const code = (err as Error).message
      if (code === 'advance_not_found') return apiFailure('not_found', 'অ্যাডভান্সটি খুঁজে পাওয়া যায়নি।', { status: 404 })
      if (code === 'advance_not_outstanding') return apiFailure('not_outstanding', 'এই অ্যাডভান্সের হিসাব আগেই দেওয়া হয়েছে।', { status: 409 })
      if (code === 'spent_out_of_range') return apiFailure('bad_spent', 'খরচ অ্যাডভান্সের চেয়ে বেশি হতে পারে না।', { status: 400 })
      throw err
    }
  } catch (e) {
    logEvent('error', 'office_advance.reconcile_failed', { error: (e as Error).message })
    return apiFailure('server_error', 'হিসাব পাঠানো যায়নি।', { status: 500 })
  }
}
