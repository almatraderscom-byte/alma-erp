import { NextRequest, NextResponse } from 'next/server'
import { sweepNoCheckoutFines } from '@/lib/attendance-checkout-fine'
import { errorMeta, logEvent } from '@/lib/logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

function cronAuthorized(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return req.headers.get('authorization') === `Bearer ${secret}`
}

/**
 * Step 2 — no-checkout fine sweep. Runs nightly at 11:00 PM Asia/Dhaka
 * (17:00 UTC). Raises one owner approval per ALMA_LIFESTYLE staff who checked
 * in today but never checked out. NEVER deducts money — only the owner's
 * APPROVE in the Approvals center posts the 500৳ fine.
 */
export async function GET(req: NextRequest) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized cron' }, { status: 401 })
  }
  try {
    const result = await sweepNoCheckoutFines()
    return NextResponse.json({ ok: result.ok, result })
  } catch (e) {
    logEvent('error', 'attendance.nocheckout_fine.cron_failed', errorMeta(e))
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  return GET(req)
}
