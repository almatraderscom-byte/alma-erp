/**
 * GET  /api/assistant/office/award  → current-week scores + stored award
 * POST /api/assistant/office/award  → owner override
 *     { action: 'recompute' } | { action: 'pin', staffId, note? } | { action: 'clear' }
 *
 * Owner-only. Auto-scoring lives in office-award.ts.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import {
  computeWeeklyScores,
  recomputeWeeklyAward,
  pinWeeklyAward,
  clearWeeklyAwardPin,
  currentWeekStart,
} from '@/agent/lib/office-award'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DEFAULT_BUSINESS = 'ALMA_LIFESTYLE'

async function requireOwner(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return { denied: disabled }
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return { denied: Response.json({ error: 'unauthorized' }, { status: 401 }) }
  if (!isSystemOwner(token)) return { denied: Response.json({ error: 'forbidden' }, { status: 403 }) }
  return { denied: null }
}

async function currentAward(businessId: string) {
  const weekStart = currentWeekStart()
  const row = await prisma.officeWeeklyAward.findUnique({
    where: { businessId_weekStart: { businessId, weekStart } },
    select: { staffId: true, score: true, auto: true, pinnedByOwner: true, note: true, staff: { select: { name: true } } },
  })
  if (!row) return null
  return {
    staffId: row.staffId,
    staffName: row.staff?.name ?? 'অজানা',
    score: row.score,
    auto: row.auto,
    pinnedByOwner: row.pinnedByOwner,
    note: row.note,
  }
}

export async function GET(req: NextRequest) {
  const { denied } = await requireOwner(req)
  if (denied) return denied

  const businessId = req.nextUrl.searchParams.get('businessId')?.trim() || DEFAULT_BUSINESS
  const [scores, award] = await Promise.all([computeWeeklyScores(businessId), currentAward(businessId)])
  return Response.json({ scores, award })
}

export async function POST(req: NextRequest) {
  const { denied } = await requireOwner(req)
  if (denied) return denied

  let body: { action?: string; staffId?: string; note?: string; businessId?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const action = body.action?.trim()
  const businessId = body.businessId?.trim() || DEFAULT_BUSINESS

  switch (action) {
    case 'recompute': {
      const res = await recomputeWeeklyAward(businessId)
      return Response.json({ ok: true, ...res, award: await currentAward(businessId) })
    }
    case 'pin': {
      const staffId = body.staffId?.trim()
      if (!staffId) return Response.json({ error: 'staffId required' }, { status: 400 })
      const res = await pinWeeklyAward(businessId, staffId, body.note)
      if (!res.ok) return Response.json({ error: res.error }, { status: 404 })
      return Response.json({ ok: true, award: await currentAward(businessId) })
    }
    case 'clear': {
      await clearWeeklyAwardPin(businessId)
      return Response.json({ ok: true, award: await currentAward(businessId) })
    }
    default:
      return Response.json({ error: 'unknown_action' }, { status: 400 })
  }
}
