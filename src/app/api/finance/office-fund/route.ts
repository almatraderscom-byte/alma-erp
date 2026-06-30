import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { mergeActorPayload } from '@/lib/api-route-actor'
import { normalizeAlmaRole } from '@/lib/roles'
import { parseMoneyInput } from '@/lib/money'
import { logEvent } from '@/lib/logger'
import { apiFailure } from '@/lib/safe-api-response'
import {
  OFFICE_FUND_BUSINESS_ID,
  computeOfficeFundSummary,
  getOfficeFundLedger,
  topUpOfficeFund,
} from '@/lib/office-fund'

export const revalidate = 0
export const runtime = 'nodejs'

/** GET → office fund balance + recent ledger. Admin / Super Admin only. */
export async function GET(req: NextRequest) {
  try {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
    if (!token?.sub) return apiFailure('unauthorized', 'Login required.', { status: 401 })
    const role = normalizeAlmaRole(token.role as string)
    if (role !== 'SUPER_ADMIN' && role !== 'ADMIN') {
      return apiFailure('forbidden', 'Office fund is admin-only.', { status: 403 })
    }

    const businessId = new URL(req.url).searchParams.get('business_id') || OFFICE_FUND_BUSINESS_ID
    const [summary, ledger] = await Promise.all([
      computeOfficeFundSummary(businessId),
      getOfficeFundLedger(businessId, 50),
    ])
    return NextResponse.json(
      { ok: true, canTopUp: role === 'SUPER_ADMIN', summary, ledger },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  } catch (e) {
    logEvent('error', 'office_fund.read_failed', { error: (e as Error).message })
    return apiFailure('server_error', 'Could not load the office fund.', { status: 500 })
  }
}

/** POST → owner tops up the office fund. Super Admin only (owner adds the cash). */
export async function POST(req: NextRequest) {
  try {
    const raw = (await req.json()) as Record<string, unknown>
    const payload = await mergeActorPayload(req, raw)
    const role = normalizeAlmaRole(String(payload.actor_role || ''))
    if (role !== 'SUPER_ADMIN') {
      return apiFailure('forbidden', 'শুধু মালিক ফান্ডে টাকা যোগ করতে পারেন।', { status: 403 })
    }

    const amount = parseMoneyInput(raw.amount as string | number | undefined)
    if (!(amount > 0)) {
      return apiFailure('bad_amount', 'সঠিক একটি টাকার অঙ্ক দিন।', { status: 400 })
    }
    const businessId = String(raw.business_id || OFFICE_FUND_BUSINESS_ID)
    const note = raw.note ? String(raw.note).slice(0, 500) : null

    const { id, balance } = await topUpOfficeFund({
      businessId,
      amount,
      note,
      createdById: String(payload.actor_user_id || '') || null,
      createdByName: String(payload.actor || '') || null,
    })

    return NextResponse.json({
      ok: true,
      entryId: id,
      balance,
      message: `ফান্ডে ৳${amount.toLocaleString('en-BD')} যোগ হয়েছে। নতুন ব্যালেন্স: ৳${balance.toLocaleString('en-BD')}।`,
    })
  } catch (e) {
    logEvent('error', 'office_fund.topup_failed', { error: (e as Error).message })
    return apiFailure('server_error', 'টাকা যোগ করা যায়নি।', { status: 500 })
  }
}
