/**
 * POST /api/assistant/internal/salah-record
 * Called by the worker to upsert/update a salah record (create at azan, update on confirmation).
 * GET  /api/assistant/internal/salah-record?date=YYYY-MM-DD → fetch all waqts for date
 * Internal token auth only.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { prisma } from '@/lib/prisma'
import { isOwnerConfirmed, isSalahSettled, reconcileConfirmedStatus } from '@/agent/lib/salah-resolve'

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

function dateObjFromYmd(date: string) {
  // Noon UTC ensures PostgreSQL DATE cast yields the correct calendar day
  return new Date(`${date}T12:00:00Z`)
}

const CONFIRMED_AT_STATUSES = new Set(['prayed_on_time', 'prayed_late', 'qaza'])

export async function GET(req: NextRequest) {
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const date = req.nextUrl.searchParams.get('date')
  if (!date) return NextResponse.json({ error: 'date required' }, { status: 400 })

  try {
    const records = await db.agentSalahRecord.findMany({
      where:   { date: dateObjFromYmd(date) },
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
  const { date, waqt, windowStart, windowEnd, status, incrementReminders, resetDay, reopen } = body as {
    date?: string; waqt?: string; windowStart?: string; windowEnd?: string;
    status?: string; incrementReminders?: boolean; resetDay?: boolean; reopen?: boolean;
  }

  if (!date || !waqt) return NextResponse.json({ error: 'date and waqt required' }, { status: 400 })

  try {
    const dateObj       = dateObjFromYmd(date)
    const windowStartDt = windowStart ? new Date(windowStart) : undefined
    const windowEndDt   = windowEnd   ? new Date(windowEnd)   : undefined
    const recordStatus  = status || 'pending'
    const now           = new Date()

    const existing = await db.agentSalahRecord.findUnique({
      where: { date_waqt: { date: dateObj, waqt } },
    })

    if (reopen && existing) {
      const record = await db.agentSalahRecord.update({
        where: { date_waqt: { date: dateObj, waqt } },
        // Keep remindersSent — avoids re-sending the same azan copy after phantom heal.
        data: { status: 'pending', confirmedAt: null },
      })
      return NextResponse.json({ ok: true, record, reopened: true })
    }

    const effectiveWindowStart = windowStartDt ?? existing?.windowStart
    if (
      existing
      && effectiveWindowStart
      && (status === 'prayed_on_time' || status === 'prayed_late')
      && now < new Date(effectiveWindowStart)
    ) {
      return NextResponse.json(
        { error: `${waqt} ওয়াক্তের সময় এখনো শুরু হয়নি — ভবিষ্যতের নামাজ মার্ক করা যাবে না।` },
        { status: 400 },
      )
    }

    // Dawn re-init: refresh windows only — never wipe owner confirmations.
    if (resetDay && existing && isOwnerConfirmed(existing)) {
      const record = await db.agentSalahRecord.update({
        where: { date_waqt: { date: dateObj, waqt } },
        data: {
          ...(windowStartDt ? { windowStart: windowStartDt } : {}),
          ...(windowEndDt ? { windowEnd: windowEndDt } : {}),
        },
      })
      return NextResponse.json({ ok: true, record })
    }

    // Escalation must not downgrade or re-miss after owner confirmed.
    if (status === 'missed' && existing && isOwnerConfirmed(existing)) {
      return NextResponse.json({ ok: true, record: existing, skipped: 'owner_confirmed' })
    }

    // Reconcile inconsistent rows (confirmedAt set but status still pending/missed).
    if (existing?.confirmedAt && status === 'missed') {
      return NextResponse.json({ ok: true, record: existing, skipped: 'already_confirmed' })
    }

    const record = await db.agentSalahRecord.upsert({
      where:  { date_waqt: { date: dateObj, waqt } },
      update: {
        ...(windowStartDt ? { windowStart: windowStartDt } : {}),
        ...(windowEndDt   ? { windowEnd: windowEndDt } : {}),
        ...(status && !(status === 'missed' && existing && isSalahSettled(existing.status))
          ? {
              status,
              ...(CONFIRMED_AT_STATUSES.has(status) ? { confirmedAt: now } : {}),
              ...(status === 'missed' ? { confirmedAt: null } : {}),
            }
          : {}),
        ...(incrementReminders ? { remindersSent: { increment: 1 } } : {}),
        ...(resetDay && !(existing && isOwnerConfirmed(existing))
          ? { remindersSent: 0, confirmedAt: null, status: recordStatus }
          : {}),
      },
      create: {
        date: dateObj,
        waqt,
        windowStart: windowStartDt ?? now,
        windowEnd: windowEndDt ?? now,
        status: recordStatus,
        ...(CONFIRMED_AT_STATUSES.has(recordStatus) ? { confirmedAt: now } : {}),
      },
    })

    // Auto-heal if confirmedAt exists but status was pending/missed.
    const healed = reconcileConfirmedStatus(
      { status: record.status, confirmedAt: record.confirmedAt, windowEnd: record.windowEnd },
      now,
    )
    if (healed) {
      const fixed = await db.agentSalahRecord.update({
        where: { date_waqt: { date: dateObj, waqt } },
        data: { status: healed },
      })
      return NextResponse.json({ ok: true, record: fixed, reconciled: true })
    }

    return NextResponse.json({ ok: true, record })
  } catch (err) {
    console.error('[salah-record POST]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
