/**
 * Minimal RRULE next-occurrence (no external dep).
 * Supports: FREQ=DAILY, FREQ=WEEKLY, FREQ=MONTHLY
 */

export function computeNextDueAt(from: Date, rrule: string): Date | null {
  const rule = rrule.trim().toUpperCase()
  const next = new Date(from.getTime())

  if (rule.includes('FREQ=DAILY') || rule === 'DAILY') {
    next.setUTCDate(next.getUTCDate() + 1)
    return next
  }

  if (rule.includes('FREQ=WEEKLY') || rule === 'WEEKLY') {
    next.setUTCDate(next.getUTCDate() + 7)
    return next
  }

  if (rule.includes('FREQ=MONTHLY') || rule === 'MONTHLY') {
    next.setUTCMonth(next.getUTCMonth() + 1)
    return next
  }

  // INTERVAL=N with FREQ=DAILY
  const intervalMatch = rule.match(/INTERVAL=(\d+)/)
  const interval = intervalMatch ? parseInt(intervalMatch[1], 10) : 1
  if (rule.includes('FREQ=DAILY')) {
    next.setUTCDate(next.getUTCDate() + interval)
    return next
  }

  return null
}

export function formatReminderConfirmation(title: string, dueAt: Date): string {
  const label = dueAt.toLocaleString('bn-BD', {
    timeZone: 'Asia/Dhaka',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
  return `⏰ রিমাইন্ডার সেট: ${title} — ${label}`
}
