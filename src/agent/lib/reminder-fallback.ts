/**
 * Reminder fallback dispatch — Vercel-side safety net.
 *
 * Primary delivery is the VPS worker ticker (worker/src/reminders/ticker.mjs,
 * every minute, with Done/Snooze buttons + escalation). But when the worker is
 * down or the ticker stalls, a due reminder used to fire NEVER — the owner set a
 * time, the agent promised, and nothing arrived. This runs from the watchdog cron
 * (every 5 min) and sends any reminder the worker has left untouched past a grace
 * window, so the promise "আমি মনে করিয়ে দেব" always lands somewhere.
 *
 * Grace window: the worker ticks every minute, so anything still unsent 3+ minutes
 * past due means the worker missed it. Only first sends (sendCount=0) — escalation
 * re-pings stay the worker's job (they need the interactive Telegram buttons).
 */
import { prisma } from '@/lib/prisma'
import { sendOwnerText } from '@/agent/lib/telegram-owner-notify'
import { notifyOwner } from '@/agent/lib/notify-owner'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const GRACE_MS = 3 * 60_000
const MAX_PER_RUN = 10

type ReminderRow = {
  id: string
  title: string
  body: string | null
  tier: number
  dueAt: Date
}

export async function runReminderFallbackDispatch(now = new Date()): Promise<{
  sent: number
  failed: number
}> {
  const cutoff = new Date(now.getTime() - GRACE_MS)
  const overdue: ReminderRow[] = await db.agentReminder.findMany({
    where: {
      sendCount: 0,
      OR: [
        { status: 'pending', dueAt: { lte: cutoff } },
        { status: 'snoozed', snoozedUntil: { lte: cutoff } },
      ],
    },
    orderBy: { dueAt: 'asc' },
    take: MAX_PER_RUN,
  })

  let sent = 0
  let failed = 0

  for (const r of overdue) {
    const title = r.title
    const message = r.body?.trim() || r.title
    let delivered = false

    try {
      const tg = await sendOwnerText(`⏰ ${title}\n\n${message}`)
      delivered = tg.ok
    } catch {
      /* fall through to ntfy */
    }

    if (!delivered || r.tier >= 2) {
      try {
        await notifyOwner({
          tier: Math.min(3, Math.max(1, r.tier)) as 1 | 2 | 3,
          category: 'urgent',
          title: `⏰ ${title}`,
          message,
          // The owner picked this exact time himself — a reminder must not be
          // parked in the overnight digest queue.
          _bypassQuietHours: true,
        })
        delivered = true
      } catch {
        /* both channels failed — leave pending for the next cron */
      }
    }

    if (!delivered) {
      failed += 1
      continue
    }

    await db.agentReminder.update({
      where: { id: r.id },
      data: {
        status: 'sent',
        lastSentAt: new Date(),
        sendCount: { increment: 1 },
      },
    })
    sent += 1
    console.log(`[reminder-fallback] sent ${r.id} (worker missed it, due ${r.dueAt.toISOString()})`)
  }

  return { sent, failed }
}
