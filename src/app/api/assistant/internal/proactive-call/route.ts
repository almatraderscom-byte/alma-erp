/**
 * POST /api/assistant/internal/proactive-call — queue a proactive-call escalation
 * (PA-2). Used by the worker / other server code for business alerts, and for
 * live verification. Body: { title, purpose, trigger?, refId? }.
 * GET ?id=<escalationId> returns the row (verification/status).
 * Auth: Bearer AGENT_INTERNAL_TOKEN.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { queueCallEscalation } from '@/agent/lib/proactive-call'

export const runtime = 'nodejs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

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

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const title = String(body.title ?? '').trim()
  const purpose = String(body.purpose ?? '').trim()
  if (!title || !purpose) {
    return NextResponse.json({ error: 'title and purpose required' }, { status: 400 })
  }
  const trigger = body.trigger === 'business_alert' ? 'business_alert' : 'manual'
  const refId = String(body.refId ?? '').trim() || `manual:${Date.now()}`

  const id = await queueCallEscalation({ trigger, refId, title, purpose })
  if (!id) return NextResponse.json({ ok: false, deduped: true })
  return NextResponse.json({ ok: true, escalationId: id })
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const row = await db.agentCallEscalation.findUnique({ where: { id } })
  if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json({ ok: true, escalation: row })
}
