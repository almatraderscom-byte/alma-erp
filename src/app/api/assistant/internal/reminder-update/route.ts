/**
 * POST /api/assistant/internal/reminder-update
 * Worker + Telegram callbacks update reminder status.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { prisma } from '@/lib/prisma'
import { computeNextDueAt } from '@/agent/lib/reminder-rrule'

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

export async function POST(req: NextRequest) {
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { id, action, sendTier, incrementSend } = body as {
    id?: string
    action?: string
    sendTier?: number
    incrementSend?: boolean
  }

  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  try {
    const existing = await db.agentReminder.findUnique({ where: { id: String(id) } })
    if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 })

    if (incrementSend) {
      const tier = sendTier ?? existing.tier
      const updated = await db.agentReminder.update({
        where: { id: String(id) },
        data: {
          status: 'sent',
          tier,
          lastSentAt: new Date(),
          sendCount: { increment: 1 },
        },
      })
      return NextResponse.json({ ok: true, reminder: updated })
    }

    const act = String(action ?? '')

    if (act === 'done' || act === 'acked') {
      const nextDue = existing.recurrenceRrule
        ? computeNextDueAt(existing.dueAt, existing.recurrenceRrule)
        : null

      if (nextDue && nextDue.getTime() > Date.now()) {
        const updated = await db.agentReminder.update({
          where: { id: String(id) },
          data: {
            status: 'pending',
            dueAt: nextDue,
            snoozedUntil: null,
            sendCount: 0,
            lastSentAt: null,
          },
        })
        return NextResponse.json({ ok: true, reminder: updated, recurring: true })
      }

      const updated = await db.agentReminder.update({
        where: { id: String(id) },
        data: { status: act === 'acked' ? 'acked' : 'done' },
      })
      return NextResponse.json({ ok: true, reminder: updated })
    }

    if (act === 'snooze') {
      const minutes = Number(body.minutes ?? 30)
      const updated = await db.agentReminder.update({
        where: { id: String(id) },
        data: {
          status: 'snoozed',
          snoozedUntil: new Date(Date.now() + minutes * 60_000),
        },
      })
      return NextResponse.json({ ok: true, reminder: updated })
    }

    if (act === 'cancel') {
      const updated = await db.agentReminder.update({
        where: { id: String(id) },
        data: { status: 'cancelled' },
      })
      return NextResponse.json({ ok: true, reminder: updated })
    }

    return NextResponse.json({ error: 'unknown action' }, { status: 400 })
  } catch (err) {
    console.error('[reminder-update]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
