import { NextRequest, NextResponse } from 'next/server'
import { requireRoles } from '@/lib/api-guards'
import { getToken } from 'next-auth/jwt'
import { resolveBusinessId } from '@/lib/businesses'
import { sendTelegramOwnerTestNotification } from '@/lib/telegram-notification/send-test'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const denied = await requireRoles(req, ['SUPER_ADMIN', 'ADMIN'])
  if (denied) return denied

  const body = (await req.json().catch(() => ({}))) as { business_id?: string }
  const businessId = resolveBusinessId(body.business_id || req.nextUrl.searchParams.get('business_id'))
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  const actorUserId = typeof token?.sub === 'string' ? token.sub : 'unknown'

  const result = await sendTelegramOwnerTestNotification(businessId, actorUserId)
  if (!result.ok) {
    return NextResponse.json({ ...result, ok: false }, { status: 400 })
  }
  return NextResponse.json({ ...result, ok: true })
}
