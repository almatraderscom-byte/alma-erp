/**
 * GET /api/assistant/internal/reminders-due
 * Returns reminders due now + sent reminders needing escalation (worker ticker).
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { prisma } from '@/lib/prisma'

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

export async function GET(req: NextRequest) {
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const now = new Date()

  try {
    const due = await db.agentReminder.findMany({
      where: {
        OR: [
          { status: 'pending', dueAt: { lte: now } },
          { status: 'snoozed', snoozedUntil: { lte: now } },
        ],
      },
      orderBy: { dueAt: 'asc' },
      take: 20,
    })

    const escalate = await db.agentReminder.findMany({
      where: {
        status: 'sent',
        tier: { gte: 2 },
        sendCount: { lt: 3 },
      },
      take: 20,
    })

    const escalationCandidates = escalate.filter((r: { dueAt: Date; sendCount: number }) => {
      const elapsedMs = now.getTime() - new Date(r.dueAt).getTime()
      if (r.sendCount === 1 && elapsedMs >= 10 * 60_000) return true
      if (r.sendCount === 2 && elapsedMs >= 25 * 60_000) return true
      return false
    })

    return NextResponse.json({ now: now.toISOString(), due, escalation: escalationCandidates })
  } catch (err) {
    console.error('[reminders-due]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
