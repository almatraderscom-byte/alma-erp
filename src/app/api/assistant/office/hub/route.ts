/**
 * GET /api/assistant/office/hub
 * Read-only self/role probe for the native iOS app.
 *
 * Tells the app whether the logged-in user is the office owner (boss) or a
 * staff member, and — for the owner only — returns the full Owner Hub data
 * (pending-approval queue, update-tracking, team status, leaderboard) as JSON.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { getOwnerHubData } from '@/agent/lib/office-hub'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DEFAULT_BUSINESS = 'ALMA_LIFESTYLE'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  try {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
    if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })

    const businessId = new URL(req.url).searchParams.get('businessId') || DEFAULT_BUSINESS

    if (isSystemOwner(token)) {
      return Response.json({ ok: true, self: 'owner', hub: await getOwnerHubData(businessId) })
    }

    const staff = await prisma.agentStaff.findFirst({
      where: { userId: token.sub, active: true },
      select: { id: true, name: true, businessId: true, userId: true },
    })
    if (staff) return Response.json({ ok: true, self: 'staff' })

    return Response.json({ ok: true, self: 'none' })
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 })
  }
}
