import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { getAllTrustRules, setTrustTier, type TrustTier } from '@/agent/lib/trust-engine'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const businessId = req.nextUrl.searchParams.get('businessId') ?? undefined
  const rules = await getAllTrustRules(businessId)
  return Response.json({ rules })
}

const VALID_TIERS = new Set<TrustTier>(['auto', 'notify', 'approve'])

export async function PATCH(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const { ruleId, tier } = await req.json() as { ruleId?: string; tier?: string }
  if (!ruleId || !tier || !VALID_TIERS.has(tier as TrustTier)) {
    return Response.json({ error: 'ruleId and valid tier (auto|notify|approve) required' }, { status: 400 })
  }

  const ok = await setTrustTier(ruleId, tier as TrustTier)
  if (!ok) return Response.json({ error: 'rule_not_found' }, { status: 404 })
  return Response.json({ ok: true, ruleId, tier })
}
