import { prisma as db } from '@/lib/prisma'
import { segmentCustomers, type CustomerSegmentResult } from '@/lib/customer-intelligence'
import { smsProviderConfigured } from '@/lib/sms/provider'
import type { AgentTool } from './registry'

/**
 * Email/SMS marketing campaign channel (Growth Feature 6). Owned-audience
 * retention: draft a campaign to an ERP customer segment (read-only reads of
 * customer data), stage ONE approval card, and only on the owner's Approve does
 * anything send. Providers are the ones the ERP already uses — sms.net.bd
 * (SMS_API_KEY) for SMS, Resend for email — no new vendors.
 *
 * STRICTLY approval-gated: this file only DRAFTS. Sending happens in the
 * approve route (actions/[id]/approve) under type 'marketing_campaign'.
 */

export type CampaignRecipient = { to: string; name?: string | null }

/** Sequential-send Vercel budget: keep a campaign batch comfortably inside a fn timeout. */
export const CAMPAIGN_MAX_RECIPIENTS = 30

const BD_PHONE_RE = /^(?:\+?88)?01[3-9]\d{8}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function normalizeBdPhone(raw: string): string | null {
  const p = raw.replace(/[\s-]/g, '')
  if (!BD_PHONE_RE.test(p)) return null
  const local = p.replace(/^\+?88/, '')
  return `88${local}`
}

/** Resolve a customer segment to deduped SMS recipients (BD phones only). */
export function segmentToSmsRecipients(
  seg: CustomerSegmentResult,
  segment: 'winBack' | 'loyal' | 'atRisk' | 'newRecent',
): CampaignRecipient[] {
  const seen = new Set<string>()
  const out: CampaignRecipient[] = []
  for (const c of seg[segment] ?? []) {
    const phone = c.phone ? normalizeBdPhone(String(c.phone)) : null
    if (!phone || seen.has(phone)) continue
    seen.add(phone)
    out.push({ to: phone, name: c.name ?? null })
  }
  return out
}

const draft_marketing_campaign: AgentTool = {
  name: 'draft_marketing_campaign',
  description:
    'Draft an owned-audience marketing campaign (SMS or email) to an ERP customer segment and stage ONE ' +
    'owner-approval card — NOTHING sends until the owner approves. SMS goes via the ERP\'s existing BD ' +
    'gateway (sms.net.bd), email via Resend. segment picks the audience (winBack/loyal/atRisk/newRecent ' +
    'from real order history); segment="test" sends ONLY to the explicit testRecipient (use this to prove ' +
    'the channel with the owner\'s own number/email first). Recipients are capped at ' +
    `${CAMPAIGN_MAX_RECIPIENTS}/batch. Message must be pure Bangla, on-brand, halal-compliant, with brand ` +
    'name and (for SMS) a short opt-out line. Use get_customer_segments first to see segment sizes.',
  input_schema: {
    type: 'object' as const,
    properties: {
      channel: { type: 'string', enum: ['sms', 'email'], description: 'Delivery channel.' },
      segment: {
        type: 'string',
        enum: ['winBack', 'loyal', 'atRisk', 'newRecent', 'test'],
        description: 'Audience segment from ERP order history, or "test" (explicit testRecipient only).',
      },
      message: { type: 'string', description: 'The campaign message (Bangla). For SMS keep ~2 SMS parts max.' },
      subject: { type: 'string', description: 'Email subject (required for channel=email).' },
      testRecipient: {
        type: 'string',
        description: 'Required when segment="test": one phone (01XXXXXXXXX) or email address.',
      },
      note: { type: 'string', description: 'Short label for the approval card, e.g. "Win-back offer জুলাই".' },
      conversationId: { type: 'string', description: 'Current conversation id (pass through so the approval card shows in this chat).' },
    },
    required: ['channel', 'segment', 'message'],
  },
  handler: async (input) => {
    try {
      const channel = String(input.channel) as 'sms' | 'email'
      const segment = String(input.segment)
      const message = String(input.message ?? '').trim()
      const subject = input.subject ? String(input.subject).trim() : ''
      const note = input.note ? String(input.note).trim() : 'মার্কেটিং ক্যাম্পেইন'
      const conversationId = input.conversationId ? String(input.conversationId) : null

      if (!message) return { success: false, error: 'message খালি — ক্যাম্পেইনের কপি দিন।' }
      if (channel === 'email' && !subject) return { success: false, error: 'email ক্যাম্পেইনে subject লাগবে।' }
      if (channel === 'sms' && !smsProviderConfigured()) {
        return { success: false, error: 'SMS_API_KEY সেট করা নেই — sms.net.bd gateway কনফিগার করা লাগবে।' }
      }

      let recipients: CampaignRecipient[] = []
      if (segment === 'test') {
        const raw = String(input.testRecipient ?? '').trim()
        if (!raw) return { success: false, error: 'segment="test"-এ testRecipient (নিজের নম্বর/ইমেইল) দিন।' }
        if (channel === 'sms') {
          const phone = normalizeBdPhone(raw)
          if (!phone) return { success: false, error: `"${raw}" বৈধ BD নম্বর নয় (01XXXXXXXXX)।` }
          recipients = [{ to: phone, name: 'Owner test' }]
        } else {
          if (!EMAIL_RE.test(raw)) return { success: false, error: `"${raw}" বৈধ ইমেইল নয়।` }
          recipients = [{ to: raw, name: 'Owner test' }]
        }
      } else {
        if (channel === 'email') {
          return {
            success: false,
            error:
              'ERP customer data-তে ইমেইল নেই (শুধু ফোন) — customer segment-এ email campaign এখনো সম্ভব না। ' +
              'channel="sms" ব্যবহার করুন, বা segment="test" দিয়ে explicit ইমেইলে পাঠান।',
          }
        }
        const seg = await segmentCustomers()
        const key = segment as 'winBack' | 'loyal' | 'atRisk' | 'newRecent'
        if (!(key in seg)) return { success: false, error: `Unknown segment: ${segment}` }
        recipients = segmentToSmsRecipients(seg, key)
        if (recipients.length === 0) {
          return { success: false, error: `"${segment}" segment-এ পাঠানোর মতো বৈধ ফোন নম্বর নেই।` }
        }
      }

      const dropped = Math.max(0, recipients.length - CAMPAIGN_MAX_RECIPIENTS)
      recipients = recipients.slice(0, CAMPAIGN_MAX_RECIPIENTS)

      const sample = recipients
        .slice(0, 3)
        .map((r) => (channel === 'sms' ? `0${r.to.slice(2, 5)}…${r.to.slice(-3)}` : r.to))
        .join(', ')
      const summary =
        `📣 ${note} — ${channel.toUpperCase()} ক্যাম্পেইন\n` +
        `Segment: ${segment} · প্রাপক: ${recipients.length} জন${dropped ? ` (cap ${CAMPAIGN_MAX_RECIPIENTS} — ${dropped} জন বাদ)` : ''}\n` +
        `নমুনা প্রাপক: ${sample}\n\n` +
        `“${message.slice(0, 200)}${message.length > 200 ? '…' : ''}”\n\n` +
        `Approve করলেই পাঠানো শুরু হবে — এর আগে কিছুই যায় না।`

      const action = await db.agentPendingAction.create({
        data: {
          conversationId,
          type: 'marketing_campaign',
          payload: { channel, segment, message, subject, recipients, note },
          summary,
          costEstimate: 0,
          status: 'pending',
        },
      })

      return {
        success: true,
        data: {
          pendingActionId: action.id,
          channel,
          segment,
          recipientCount: recipients.length,
          droppedByCap: dropped,
          message: `ক্যাম্পেইন খসড়া রেডি — ${recipients.length} জন প্রাপক। owner Approve করলে পাঠানো হবে।`,
        },
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

export const CAMPAIGN_TOOLS: AgentTool[] = [draft_marketing_campaign]

export const CAMPAIGN_ROLE_PROMPT = `
## ক্যাম্পেইন (Email/SMS)
নিজস্ব কাস্টমার-লিস্টে retention ক্যাম্পেইন পাঠাতে **draft_marketing_campaign** — আগে get_customer_segments দিয়ে segment size দেখুন, তারপর খাঁটি বাংলা, on-brand, হালাল কপি লিখে draft করুন (SMS-এ ব্র্যান্ড নাম + সংক্ষিপ্ত opt-out লাইন রাখুন)। এক ব্যাচে সর্বোচ্চ ${CAMPAIGN_MAX_RECIPIENTS} জন। **কিছুই নিজে যায় না — owner এক approval card-এ Approve করলে তবেই পাঠানো হয়।** নতুন চ্যানেল প্রথমবার প্রমাণ করতে segment="test" দিয়ে owner-এর নিজের নম্বর/ইমেইলে পাঠান।
`
