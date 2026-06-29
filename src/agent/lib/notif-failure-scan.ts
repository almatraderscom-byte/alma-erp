/**
 * Staff send-failure detection.
 *
 * The Telegram notification queue already retries (maxAttempts) and dead-letters,
 * but a message that exhausts every retry just sits in FAILED — the owner is never
 * told that a staff alert never landed. This scan runs from the watchdog cron: it
 * finds queue rows that gave up since the last check and raises one consolidated
 * owner alert (which itself falls back to Telegram via notifyOwner).
 *
 * A KV watermark makes the scan idempotent across cron ticks, and a first-run with
 * no watermark only arms the clock (no alert) so a fresh deploy never floods the
 * owner with the historical backlog.
 */
import { prisma } from '@/lib/prisma'
import { notifyOwner } from '@/agent/lib/notify-owner'

const WATERMARK_KEY = 'notif_failure_watermark'
const SCAN_LIMIT = 100

export interface StaffFailureScanResult {
  failed: number
  alerted: boolean
  firstRun: boolean
  summary: string | null
}

async function readWatermark(): Promise<Date | null> {
  const row = await prisma.agentKvSetting.findUnique({ where: { key: WATERMARK_KEY } })
  if (!row?.value) return null
  const ms = Date.parse(row.value)
  return Number.isNaN(ms) ? null : new Date(ms)
}

async function writeWatermark(at: Date): Promise<void> {
  const value = at.toISOString()
  await prisma.agentKvSetting.upsert({
    where: { key: WATERMARK_KEY },
    create: { key: WATERMARK_KEY, value },
    update: { value },
  })
}

/** Scan the Telegram queue for permanently-failed staff messages and alert the owner once. */
export async function scanStaffSendFailures(): Promise<StaffFailureScanResult> {
  const scanAt = new Date()
  const watermark = await readWatermark()

  // First run: just arm the clock — don't alert on pre-existing failures.
  if (!watermark) {
    await writeWatermark(scanAt)
    return { failed: 0, alerted: false, firstRun: true, summary: null }
  }

  const rows = await prisma.telegramNotificationQueue.findMany({
    where: { status: 'FAILED', updatedAt: { gt: watermark } },
    orderBy: { updatedAt: 'asc' },
    take: SCAN_LIMIT,
    select: { eventType: true, attempts: true, maxAttempts: true, errorMessage: true, chatId: true },
  })

  // Only count rows that exhausted every retry — these are the truly undeliverable ones.
  const terminal = rows.filter((r) => r.attempts >= r.maxAttempts)

  // Advance the watermark regardless, so transient FAILED rows aren't re-scanned forever.
  await writeWatermark(scanAt)

  if (terminal.length === 0) {
    return { failed: 0, alerted: false, firstRun: false, summary: null }
  }

  const byEvent = new Map<string, number>()
  for (const r of terminal) byEvent.set(r.eventType, (byEvent.get(r.eventType) ?? 0) + 1)
  const breakdown = [...byEvent.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([ev, n]) => `${ev}×${n}`)
    .join(', ')
  const sampleErr = terminal.find((r) => r.errorMessage)?.errorMessage?.slice(0, 120)

  const summary =
    `${terminal.length}টি স্টাফ মেসেজ সব রিট্রাই শেষেও Telegram-এ পৌঁছায়নি।\n` +
    `ধরন: ${breakdown}\n` +
    (sampleErr ? `কারণ: ${sampleErr}\n` : '') +
    `বট টোকেন / staff chat ID / VPS worker চেক করুন।`

  await notifyOwner({ tier: 2, category: 'urgent', title: 'স্টাফ মেসেজ যায়নি', message: summary })

  return { failed: terminal.length, alerted: true, firstRun: false, summary }
}
