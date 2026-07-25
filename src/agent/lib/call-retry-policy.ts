/**
 * Human-PA point 3 (owner audit 2026-07-24) — a call nobody answered is not the
 * end. Like a human PA: try again later (10 min, max 2 retries via the
 * scheduled-calls cron), and when the line stays dead, drop the message as a
 * WhatsApp text and tell the boss what happened.
 *
 * Scope guards:
 *  - third-party calls only (never the owner — his ladder handles him; never
 *    inbound records, there is nobody to redial);
 *  - retry count rides a [পুনঃচেষ্টা N/2] tag inside purpose — no schema change;
 *  - fail-open: any error here must never break report delivery.
 */
import { prisma } from '@/lib/prisma'
import { isOwnerNumber } from '@/agent/lib/voice-call'
import { notifyOwner } from '@/agent/lib/notify-owner'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const RETRY_TAG_RE = /\[পুনঃচেষ্টা (\d)\/2\]/
export const MAX_CALL_RETRIES = 2
const RETRY_DELAY_MIN = 10

export function parseRetryCount(purpose: string | null | undefined): number {
  const m = RETRY_TAG_RE.exec(purpose ?? '')
  return m ? Number(m[1]) : 0
}

function stripRetryTag(purpose: string): string {
  return purpose.replace(RETRY_TAG_RE, '').trim()
}

/** Should this terminal report trigger the retry policy at all? */
export function retryEligible(record: {
  toNumber?: string | null
  purpose?: string | null
  recipientName?: string | null
}, status: string): boolean {
  if (!['no_answer', 'busy'].includes(status)) return false
  const to = String(record.toNumber ?? '')
  if (!to || to === 'unknown') return false
  if (isOwnerNumber(to)) return false
  if (String(record.purpose ?? '').startsWith('inbound')) return false
  return true
}

/**
 * Apply the policy for an unanswered third-party call. Returns what happened
 * (for logs/tests): 'rebooked' | 'text_fallback' | 'skipped'.
 */
export async function applyCallRetryPolicy(record: {
  id: string
  toNumber: string | null
  recipientName: string | null
  purpose: string | null
  firstMessage: string | null
  conversationId: string | null
  status?: string | null
}, terminalStatus: string): Promise<'rebooked' | 'text_fallback' | 'skipped'> {
  try {
    if (!retryEligible(record, terminalStatus)) return 'skipped'
    const attempts = parseRetryCount(record.purpose)
    const basePurpose = stripRetryTag(String(record.purpose ?? ''))
    const who = record.recipientName ?? record.toNumber

    if (attempts < MAX_CALL_RETRIES) {
      const next = attempts + 1
      await db.scheduledCall.create({
        data: {
          toNumber: record.toNumber,
          recipientName: record.recipientName,
          purpose: `${basePurpose} [পুনঃচেষ্টা ${next}/2]`,
          firstMessage: record.firstMessage,
          callType: 'contact',
          // Male is the house voice; a retry must not switch the speaker mid-conversation.
          voiceGender: 'male',
          dueAt: new Date(Date.now() + RETRY_DELAY_MIN * 60_000),
          conversationId: record.conversationId,
        },
      })
      await notifyOwner({
        tier: 1,
        title: `📞 ${who} ধরেননি`,
        message: `কল ধরা হয়নি — ${RETRY_DELAY_MIN} মিনিট পরে আবার চেষ্টা করব (${next}/${MAX_CALL_RETRIES})।`,
        category: 'task',
      }).catch(() => {})
      return 'rebooked'
    }

    // Retries exhausted → drop the message as WhatsApp text (best-effort) + tell the boss.
    let waNote = 'WhatsApp text পাঠানো যায়নি (setup/permission)।'
    try {
      const { sendTwilioWaText } = await import('@/agent/lib/wa/twilio-wa')
      const body =
        `আসসালামু আলাইকুম${record.recipientName ? ` ${record.recipientName}` : ''}। ALMA থেকে আপনাকে কয়েকবার কল করা হয়েছিল কিন্তু পাওয়া যায়নি। ` +
        `বিষয়: ${basePurpose.slice(0, 300)}। সুবিধামতো সময়ে এই নম্বরে জানালে কৃতজ্ঞ থাকব।`
      const sent = await sendTwilioWaText({ to: String(record.toNumber), body })
      if (sent.sid) waNote = 'WhatsApp-এ মেসেজটা লিখে পাঠিয়ে দিয়েছি।'
      else if (sent.error) waNote = `WhatsApp text যায়নি: ${sent.error.slice(0, 120)}`
    } catch { /* fail-open */ }

    await notifyOwner({
      tier: 2,
      title: `📞 ${who} — ${MAX_CALL_RETRIES + 1} বারেও ধরা হয়নি`,
      message: `বিষয়: ${basePurpose.slice(0, 200)}। ${waNote}`,
      category: 'task',
      telegramMode: 'always',
    }).catch(() => {})
    return 'text_fallback'
  } catch (err) {
    console.warn('[call-retry] policy failed:', err instanceof Error ? err.message : String(err))
    return 'skipped'
  }
}
