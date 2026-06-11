/**
 * POST /api/assistant/internal/salah-record
 * Called by the worker to upsert/update a salah record (create at azan, update on confirmation).
 * GET  /api/assistant/internal/salah-record?date=YYYY-MM-DD → fetch all waqts for date
 * Internal token auth only.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { prisma } from '@/lib/prisma'

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

  const date = req.nextUrl.searchParams.get('date')
  if (!date) return NextResponse.json({ error: 'date required' }, { status: 400 })

  const records = await db.agentSalahRecord.findMany({
    where:   { date: new Date(date) },
    orderBy: { windowStart: 'asc' },
  })

  return NextResponse.json({ date, records })
}

export async function POST(req: NextRequest) {
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const { date, waqt, windowStart, windowEnd, status, incrementReminders } = body as {
    date?: string; waqt?: string; windowStart?: string; windowEnd?: string;
    status?: string; incrementReminders?: boolean;
  }

  if (!date || !waqt) return NextResponse.json({ error: 'date and waqt required' }, { status: 400 })

  const dateObj        = new Date(date)
  const windowStartDt  = windowStart ? new Date(windowStart) : new Date()
  const windowEndDt    = windowEnd   ? new Date(windowEnd)   : new Date()
  const recordStatus   = status || 'pending'

  const record = await db.agentSalahRecord.upsert({
    where:  { date_waqt: { date: dateObj, waqt } },
    update: {
      ...(status              ? { status, confirmedAt: ['prayed_on_time','prayed_late','qaza','missed'].includes(status) ? new Date() : null } : {}),
      ...(incrementReminders  ? { remindersSent: { increment: 1 } } : {}),
    },
    create: {
      date: dateObj, waqt, windowStart: windowStartDt, windowEnd: windowEndDt,
      status: recordStatus,
    },
  })

  return NextResponse.json({ ok: true, record })
}
