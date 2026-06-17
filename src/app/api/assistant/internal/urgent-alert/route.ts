/**
 * POST /api/assistant/internal/urgent-alert
 * Queues notify dispatch. Tier 2 instant; tier 3 requires owner approval unless preAuthorized.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { prisma } from '@/lib/prisma'
import { checkUrgentRateLimit } from '@/agent/lib/urgent-rate-limit'

export const runtime = 'nodejs'

function checkToken(req: NextRequest): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN
  if (!expected) return false
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  } catch {
    return false
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const PRE_AUTH_TIER3_CATEGORIES = new Set([
  'staff_approval_escalation',
  'duty_approval_escalation',
])

export async function POST(req: NextRequest) {
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const tier = Number(body.tier) === 3 ? 3 : 2
  const title = String(body.title ?? '').trim()
  const message = String(body.message ?? '').trim()
  const voice = body.voice !== false
  const category = String(body.category ?? '').trim()
  const preAuthorized = body.preAuthorized === true
    || PRE_AUTH_TIER3_CATEGORIES.has(category)

  if (!title || !message) {
    return NextResponse.json({ error: 'title and message required' }, { status: 400 })
  }

  const rate = await checkUrgentRateLimit(tier as 2 | 3)
  if (!rate.ok) {
    return NextResponse.json({ error: rate.error }, { status: 429 })
  }

  const instantDispatch = tier === 2 || (tier === 3 && preAuthorized)

  try {
    const action = await db.agentPendingAction.create({
      data: {
        type: 'urgent_notify',
        payload: { tier, title, message, voice, category: category || undefined },
        summary: `${tier === 3 ? '📞' : '🚨'} ${title}`,
        costEstimate: tier === 3 ? 0.05 : 0,
        status: instantDispatch ? 'approved' : 'pending',
        resolvedAt: instantDispatch ? new Date() : null,
      },
    })

    return NextResponse.json({
      ok: true,
      queued: instantDispatch,
      pendingApproval: !instantDispatch,
      actionId: action.id,
    })
  } catch (err) {
    console.error('[urgent-alert]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
