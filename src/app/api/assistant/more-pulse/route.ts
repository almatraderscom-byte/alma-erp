/**
 * GET /api/assistant/more-pulse
 * Aggregate feed for the native iOS "More" screen.
 *
 * Same auth pattern as live-pulse (agent kill switch → NextAuth cookie token),
 * but NOT owner-only: both the owner and linked staff get data, with branched
 * payloads. All aggregation lives in src/agent/lib/more-pulse.ts; each section
 * there is individually fault-tolerant so this route never 500s on one bad
 * data source.
 *
 * Owner-only query param: ?business_id= (also accepts ?businessId= like the
 * office hub route) — validated against ALL_BUSINESS_IDS, default
 * ALMA_LIFESTYLE. Ignored for staff callers (their business comes from their
 * AgentStaff row).
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { ALL_BUSINESS_IDS, parseBusinessAccess } from '@/lib/business-access'
import { buildMorePulse } from '@/agent/lib/more-pulse'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DEFAULT_BUSINESS = 'ALMA_LIFESTYLE'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })

  // Owner business selector — mirror the office hub's param handling, but
  // validate against the canonical business list (bad values fall back to
  // the default rather than erroring).
  const params = new URL(req.url).searchParams
  const requested = params.get('business_id') || params.get('businessId') || DEFAULT_BUSINESS
  const ownerBusinessId = (ALL_BUSINESS_IDS as string[]).includes(requested)
    ? requested
    : DEFAULT_BUSINESS

  const pulse = await buildMorePulse({
    userId: token.sub,
    name: typeof token.name === 'string' && token.name.trim() ? token.name : 'ব্যবহারকারী',
    isOwner: isSystemOwner(token),
    businessAccess: parseBusinessAccess(token.businessAccess as string | undefined),
    ownerBusinessId,
  })

  return Response.json(pulse)
}
