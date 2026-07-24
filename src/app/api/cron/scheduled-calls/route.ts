/**
 * GET /api/cron/scheduled-calls — fires due scheduled two-way calls (Phase C).
 * Runs every minute (vercel.json). Finds scheduled_calls rows whose dueAt has passed and
 * places each via placeOutboundCall (which enforces the kill-switch, daily cap, personas,
 * and post-call summary). Auth: Bearer CRON_SECRET, same as the other crons.
 *
 * A too-old row (missed by > STALE_MIN, e.g. the cron was down) is marked 'missed' rather
 * than dialed late — nobody wants a reminder call hours after the fact.
 */
import { type NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { placeOutboundCall } from '@/agent/lib/voice-call'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any


/** Human-PA point 4 — next occurrence for a recurring call row. */
function nextRecurrence(dueAt: Date, recurrence: string): Date | null {
  const next = new Date(dueAt)
  if (recurrence === 'daily') { next.setUTCDate(next.getUTCDate() + 1); return next }
  if (recurrence === 'weekly') { next.setUTCDate(next.getUTCDate() + 7); return next }
  if (recurrence === 'weekdays') {
    // Dhaka business week: skip Friday+Saturday.
    do { next.setUTCDate(next.getUTCDate() + 1) }
    while (['Fri', 'Sat'].includes(next.toLocaleDateString('en-US', { timeZone: 'Asia/Dhaka', weekday: 'short' })))
    return next
  }
  return null
}

/** Book the next occurrence (fired OR missed — a human PA does not skip tomorrow
 *  because today slipped). Duplicate-safe: skips if an identical future row exists. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function rebookRecurring(db: any, row: { id: string; recurrence?: string | null; dueAt: Date; toNumber: string; recipientName: string | null; purpose: string; firstMessage: string | null; callType: string; voiceGender: string; conversationId: string | null; businessId: string }) {
  if (!row.recurrence) return
  const nextAt = nextRecurrence(new Date(row.dueAt), row.recurrence)
  if (!nextAt) return
  const dup = await db.scheduledCall.findFirst({
    where: { toNumber: row.toNumber, purpose: row.purpose, status: 'scheduled', dueAt: nextAt },
    select: { id: true },
  })
  if (dup) return
  await db.scheduledCall.create({
    data: {
      toNumber: row.toNumber, recipientName: row.recipientName, purpose: row.purpose,
      firstMessage: row.firstMessage, callType: row.callType, voiceGender: row.voiceGender,
      dueAt: nextAt, recurrence: row.recurrence, conversationId: row.conversationId,
      businessId: row.businessId,
    },
  }).catch(() => {})
}

const STALE_MIN = 30
const MAX_PER_RUN = 5

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim()
  if (!secret) return Response.json({ error: 'cron_unconfigured' }, { status: 503 })
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  const now = Date.now()
  const due = await db.scheduledCall.findMany({
    where: { status: 'scheduled', dueAt: { lte: new Date(now) } },
    orderBy: { dueAt: 'asc' },
    take: MAX_PER_RUN,
  })

  const results: Array<{ id: string; outcome: string }> = []
  for (const row of due) {
    const ageMin = (now - new Date(row.dueAt).getTime()) / 60_000
    if (ageMin > STALE_MIN) {
      await db.scheduledCall.update({ where: { id: row.id }, data: { status: 'missed', error: `stale ${Math.round(ageMin)}m` } })
      await rebookRecurring(db, row)
      results.push({ id: row.id, outcome: 'missed_stale' })
      continue
    }
    // Claim the row first (status→placing) so a concurrent cron run can't double-dial it.
    const claimed = await db.scheduledCall.updateMany({
      where: { id: row.id, status: 'scheduled' },
      data: { status: 'placing' },
    })
    if (claimed.count !== 1) { results.push({ id: row.id, outcome: 'already_claimed' }); continue }

    try {
      const res = await placeOutboundCall({
        toNumber: row.toNumber,
        recipientName: row.recipientName ?? undefined,
        purpose: row.purpose,
        firstMessage: row.firstMessage ?? '',
        voiceGender: row.voiceGender === 'male' ? 'male' : 'female',
        callType: row.callType === 'staff' ? 'staff' : row.callType === 'owner' ? 'owner' : 'contact',
        conversationId: row.conversationId ?? undefined,
      })
      if (res.ok) {
        await db.scheduledCall.update({ where: { id: row.id }, data: { status: 'placed', placedCallId: res.callRecordId ?? null, placedAt: new Date(), error: null } })
        await rebookRecurring(db, row)
        results.push({ id: row.id, outcome: 'placed' })
      } else {
        await db.scheduledCall.update({ where: { id: row.id }, data: { status: 'failed', error: (res.error ?? 'failed').slice(0, 300) } })
        await rebookRecurring(db, row)
        results.push({ id: row.id, outcome: 'failed' })
      }
    } catch (err) {
      await db.scheduledCall.update({ where: { id: row.id }, data: { status: 'failed', error: (err instanceof Error ? err.message : String(err)).slice(0, 300) } })
      results.push({ id: row.id, outcome: 'error' })
    }
  }

  return Response.json({ ok: true, fired: results.length, results })
}
