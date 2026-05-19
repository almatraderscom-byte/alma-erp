import { NextRequest, NextResponse } from 'next/server'
import { getWalletContext } from '@/lib/payroll-wallet-access'
import { getPenaltyAppealAnalytics } from '@/lib/penalty-appeal'
import { attendanceDateFor } from '@/lib/attendance'

function monthRange(date: Date) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1))
  return { start, end }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const ctx = await getWalletContext(req, url.searchParams.get('business_id'))
  if ('error' in ctx) return ctx.error
  if (!ctx.isAdmin) {
    return NextResponse.json({ error: 'Admin access required.' }, { status: 403 })
  }

  const date = url.searchParams.get('month')
    ? attendanceDateFor(new Date(`${url.searchParams.get('month')}-01T12:00:00Z`))
    : attendanceDateFor()
  const { start, end } = monthRange(date)
  const analytics = await getPenaltyAppealAnalytics(ctx.businessIds[0], start, end)

  return NextResponse.json({ ok: true, month: start.toISOString().slice(0, 7), analytics })
}
