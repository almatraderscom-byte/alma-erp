/**
 * POST /api/assistant/internal/salah-record
 * Called by the worker to upsert/update a salah record (create at azan, update on confirmation).
 * GET  /api/assistant/internal/salah-record?date=YYYY-MM-DD → fetch all waqts for date
 * Internal token auth only.
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

  const date = req.nextUrl.searchParams.get('date')
  if (!date) return NextResponse.json({ error: 'date required' }, { status: 400 })

  try {
    const records = await db.agentSalahRecord.findMany({
      where:   { date: new Date(`${date}T00:00:00+06:00`) },
      orderBy: { windowStart: 'asc' },
    })
    return NextResponse.json({ date, records })
  } catch (err) {
    console.error('[salah-record GET]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const { date, waqt, windowStart, windowEnd, status, incrementReminders, resetDay } = body as {
    date?: string; waqt?: string; windowStart?: string; windowEnd?: string;
    status?: string; incrementReminders?: boolean; resetDay?: boolean;
  }

  if (!date || !waqt) return NextResponse.json({ error: 'date and waqt required' }, { status: 400 })

  try {
    const dateObj        = new Date(`${date}T00:00:00+06:00`)
    const windowStartDt  = windowStart ? new Date(windowStart) : new Date()
    const windowEndDt    = windowEnd   ? new Date(windowEnd)   : new Date()
    const recordStatus   = status || 'pending'

    const record = await db.agentSalahRecord.upsert({
      where:  { date_waqt: { date: dateObj, waqt } },
      update: {
        ...(windowStart           ? { windowStart: windowStartDt } : {}),
        ...(windowEnd             ? { windowEnd: windowEndDt } : {}),
        ...(status              ? { status, confirmedAt: ['prayed_on_time','prayed_late','qaza','missed'].includes(status) ? new Date() : null } : {}),
        ...(incrementReminders  ? { remindersSent: { increment: 1 } } : {}),
        ...(resetDay            ? { remindersSent: 0, confirmedAt: null } : {}),
      },
      create: {
        date: dateObj, waqt, windowStart: windowStartDt, windowEnd: windowEndDt,
        status: recordStatus,
      },
    })

    return NextResponse.json({ ok: true, record })
  } catch (err) {
    console.error('[salah-record POST]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
