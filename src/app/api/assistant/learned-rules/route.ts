import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { listLearnedRules } from '@/agent/lib/learning/learned-rules'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const businessId = req.nextUrl.searchParams.get('businessId') === 'ALMA_TRADING'
    ? 'ALMA_TRADING'
    : 'ALMA_LIFESTYLE'

  const { rules, grouped } = await listLearnedRules(businessId)
  return Response.json({ rules, grouped, count: rules.length })
}
