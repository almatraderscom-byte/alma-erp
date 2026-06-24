/**
 * GET /api/assistant/office/history            → index of past days (owner)
 * GET /api/assistant/office/history?date=YYYY-MM-DD → full board for one day
 *
 * Owner-only. The board for any past day is reconstructed on demand from the
 * durable task + event records — no snapshot table is involved.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { getOfficeHistoryIndex, getOfficeHistoryDay } from '@/agent/lib/office-hub'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DEFAULT_BUSINESS = 'ALMA_LIFESTYLE'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const businessId = req.nextUrl.searchParams.get('businessId')?.trim() || DEFAULT_BUSINESS
  const date = req.nextUrl.searchParams.get('date')?.trim()

  if (date) {
    const day = await getOfficeHistoryDay(businessId, date)
    if (!day) return Response.json({ error: 'not_found' }, { status: 404 })
    return Response.json(day)
  }

  const index = await getOfficeHistoryIndex(businessId)
  return Response.json({ days: index })
}
