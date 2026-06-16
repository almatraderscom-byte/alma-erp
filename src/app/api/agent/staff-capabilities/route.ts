import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { getAllStaffCapabilities } from '@/agent/lib/intelligence/staff-capability'
import { extractBearerToken, verifyAgentInternalToken } from '@/lib/agent-internal-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  if (!verifyAgentInternalToken(extractBearerToken(req.headers.get('authorization')))) {
    const { getToken } = await import('next-auth/jwt')
    const { isSystemOwner } = await import('@/lib/roles')
    const jwt = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
    if (!jwt?.sub || !isSystemOwner(jwt)) {
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    }
  }

  const businessId = req.nextUrl.searchParams.get('businessId') ?? 'ALMA_LIFESTYLE'
  const profiles = await getAllStaffCapabilities(businessId)
  return Response.json(profiles)
}
