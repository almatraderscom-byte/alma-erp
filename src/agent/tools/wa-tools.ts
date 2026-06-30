import type { AgentTool } from './registry'
import { prisma } from '@/lib/prisma'
import { sendTwilioWaText, placeTwilioWaCall, twilioWaConfigured } from '@/agent/lib/wa/twilio-wa'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const looksLikePhone = (s: string) => /^\+?\d[\d\s\-()]{6,}$/.test(s.trim())

/**
 * Resolve a staff/employee NAME → their WhatsApp/phone number from the ERP, so the
 * owner can say "Eyafi-কে WhatsApp করো" without giving a number. Staff numbers live
 * on the linked ERP User (AgentStaff.user.phone) — the same source office-hub uses
 * for the owner's quick-call button — with a fallback to the employee User directly.
 */
async function resolveRecipientPhone(nameOrPhone: string, businessId: 'ALMA_LIFESTYLE' | 'ALMA_TRADING'): Promise<string | null> {
  const q = nameOrPhone.trim()
  if (!q) return null
  if (looksLikePhone(q)) return q

  // 1) Active staff member by name → linked ERP user's phone.
  const staff = await db.agentStaff.findFirst({
    where: { name: { contains: q, mode: 'insensitive' }, active: true, businessId },
    select: { user: { select: { phone: true } } },
  })
  if (staff?.user?.phone) return staff.user.phone as string

  // 2) ERP employee/user directory by name (employees carry phone + employeeIdGas).
  const user = await db.user.findFirst({
    where: { name: { contains: q, mode: 'insensitive' }, phone: { not: null } },
    select: { phone: true },
  })
  return (user?.phone as string | undefined) ?? null
}

/**
 * Send a WhatsApp text via the business WhatsApp (Twilio path). The recipient can be
 * a phone number OR a staff/employee NAME — the agent looks the number up from the
 * ERP profile. Dormant + safe: returns a clear error when Twilio WhatsApp isn't
 * configured, and the WHATSAPP_SEND_ENABLED kill switch must be on before anything
 * is sent (so setting the creds alone never makes the agent send).
 */
const send_whatsapp: AgentTool = {
  name: 'send_whatsapp',
  description:
    'Sends a WhatsApp TEXT via the business WhatsApp number (Twilio). ' +
    'Use when Sir asks to send/test a WhatsApp message. ' +
    'to = either a phone in international format (e.g. +8801712345678) OR a staff/employee NAME ' +
    '(e.g. "Mohammad Eyafi") — the agent resolves the name to their number from the ERP profile. ' +
    'Owner-directed sends only — never unsolicited customer marketing. ' +
    'NOTE: free-form text reaches a recipient only inside the 24h window after THEY last messaged ' +
    'the business; a cold/proactive message needs an approved WhatsApp template (not yet wired).',
  input_schema: {
    type: 'object' as const,
    properties: {
      to: { type: 'string', description: 'Recipient: phone (+8801…) OR a staff/employee name to look up' },
      message: { type: 'string', description: 'Message text (max 1600 chars)' },
    },
    required: ['to', 'message'],
  },
  handler: async (input) => {
    const rawTo = String(input.to ?? '').trim()
    const message = String(input.message ?? '').trim()
    if (!rawTo || !message) return { success: false, error: 'to ও message — দুটোই দরকার।' }
    if (!twilioWaConfigured()) {
      return {
        success: false,
        error:
          'WhatsApp এখনো setup হয়নি — Twilio WhatsApp creds সেট করা নেই (TWILIO_WHATSAPP_FROM)। Sir-কে বলুন Twilio setup শেষ করে credentials দিতে।',
      }
    }
    if (process.env.WHATSAPP_SEND_ENABLED !== 'true') {
      return {
        success: false,
        error: 'WhatsApp পাঠানো এখন বন্ধ আছে (kill switch)। চালু করতে WHATSAPP_SEND_ENABLED=true সেট করুন।',
      }
    }

    const businessId = input.businessId === 'ALMA_TRADING' ? 'ALMA_TRADING' : 'ALMA_LIFESTYLE'
    const to = await resolveRecipientPhone(rawTo, businessId)
    if (!to) {
      return {
        success: false,
        error: `"${rawTo}"-এর WhatsApp নম্বর প্রোফাইলে পাওয়া যায়নি। নম্বরটা সরাসরি দিন (+8801…) অথবা স্টাফের ERP প্রোফাইলে ফোন নম্বর যোগ করুন।`,
      }
    }

    const res = await sendTwilioWaText({ to, body: message })
    if (res.error) return { success: false, error: `WhatsApp পাঠানো যায়নি: ${res.error}` }
    return { success: true, data: { sid: res.sid, to, resolvedFrom: looksLikePhone(rawTo) ? 'number' : 'name', sent: true } }
  },
}

/** Pull readable text out of a CsMessage.content JSON ([{type:'text',text}] or string). */
function csMessageText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    const parts = content
      .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text?: unknown }).text ?? '') : ''))
      .filter(Boolean)
    if (parts.length) return parts.join(' ').trim()
    // Non-text block (image/audio) → a short marker so the owner sees "something arrived".
    const types = content
      .map((b) => (b && typeof b === 'object' && 'type' in b ? String((b as { type?: unknown }).type ?? '') : ''))
      .filter(Boolean)
    if (types.length) return `(${types[0]})`
  }
  return ''
}

/** Shape of one CsConversation row selected by get_wa_inbox (db is `prisma as any`). */
type WaInboxRow = {
  psid: string
  customerName: string | null
  mode: string
  lastMessageAt: Date | null
  lastCustomerMessageAt: Date | null
  lastCsReplyAt: Date | null
  messages: Array<{ role: string; content: unknown }>
}

/**
 * Read-only WhatsApp inbox — the messages staff/customers sent TO the business
 * WhatsApp number. Unlike Messenger (live Graph API), Twilio WhatsApp inbound is
 * stored in our own CsConversation/CsMessage tables (pageId prefixed "wa:"), so
 * this reads from the DB. Lets the owner ask "WhatsApp-এ কী মেসেজ এসেছে দেখাও".
 */
const get_wa_inbox: AgentTool = {
  name: 'get_wa_inbox',
  description:
    'Reads recent WhatsApp inbox threads (read-only) — messages staff/customers sent to the business ' +
    'WhatsApp number. Use when Sir asks "WhatsApp-এ কী মেসেজ এসেছে / কে মেসেজ দিয়েছে / inbox দেখাও". ' +
    'limit: 1–25 threads (default 15).',
  input_schema: {
    type: 'object' as const,
    properties: { limit: { type: 'number', description: '1–25 threads (default 15)' } },
  },
  handler: async (input) => {
    try {
      const limit = Math.min(Math.max(Number(input.limit ?? 15), 1), 25)
      // `db` is `prisma as any`, so annotate the row shape explicitly — otherwise the
      // map/filter callbacks below become implicit-any and fail `next build`'s strict
      // type-check (this is what broke the production deploy).
      const convs: WaInboxRow[] = await db.csConversation.findMany({
        where: { pageId: { startsWith: 'wa:' } },
        orderBy: { lastMessageAt: 'desc' },
        take: limit,
        select: {
          psid: true,
          customerName: true,
          mode: true,
          lastMessageAt: true,
          lastCustomerMessageAt: true,
          lastCsReplyAt: true,
          messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { role: true, content: true } },
        },
      })
      const threads = convs.map((c) => {
        const last = c.messages?.[0]
        const unanswered =
          c.lastCustomerMessageAt && (!c.lastCsReplyAt || c.lastCustomerMessageAt > c.lastCsReplyAt)
        return {
          number: c.psid,
          name: c.customerName || c.psid,
          lastMessage: csMessageText(last?.content) || '(মিডিয়া/খালি)',
          lastFrom: last?.role === 'user' ? 'them' : 'us',
          at: c.lastMessageAt,
          needsReply: Boolean(unanswered),
          mode: c.mode,
        }
      })
      const awaitingReply = threads.filter((t) => t.needsReply).length
      return { success: true, data: { count: threads.length, awaitingReply, threads } }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

/**
 * Place a ONE-WAY WhatsApp voice call (Twilio): the agent speaks the reminder and
 * hangs up — it does NOT listen. Like outbound_phone_call but on WhatsApp. Use when
 * Sir says "WhatsApp-এ কল করে মনে করিয়ে দাও / call করে বলো"。 Recipient = phone OR a
 * staff/employee NAME (resolved from the ERP profile, same as send_whatsapp).
 *
 * Dormant + DOUBLE-gated: Twilio creds AND WHATSAPP_CALL_ENABLED=true. Beyond that,
 * WhatsApp's own rules require Business Calling enabled on the sender AND the
 * recipient to have granted call permission — until both are true Twilio rejects
 * the call and the agent surfaces that error verbatim.
 */
const whatsapp_call: AgentTool = {
  name: 'whatsapp_call',
  description:
    'Places a ONE-WAY WhatsApp voice call (Twilio) that SPEAKS a short reminder/message then hangs up — ' +
    'the agent does not listen or take input. Use when Sir asks to CALL someone on WhatsApp to remind them ' +
    '(e.g. "Eyafi-কে WhatsApp-এ কল করে বলো বস কল করতে"). ' +
    'to = phone in international format (+8801…) OR a staff/employee NAME (resolved from the ERP profile). ' +
    'message = what to say (kept short). Owner-directed reminders only. ' +
    'NOTE: WhatsApp calling needs Business Calling enabled on the sender AND the recipient must have granted ' +
    'call permission — otherwise the call is rejected by WhatsApp.',
  input_schema: {
    type: 'object' as const,
    properties: {
      to: { type: 'string', description: 'Recipient: phone (+8801…) OR a staff/employee name to look up' },
      message: { type: 'string', description: 'What the call should say (kept short, max ~600 chars)' },
    },
    required: ['to', 'message'],
  },
  handler: async (input) => {
    const rawTo = String(input.to ?? '').trim()
    const message = String(input.message ?? '').trim()
    if (!rawTo || !message) return { success: false, error: 'to ও message — দুটোই দরকার।' }
    if (!twilioWaConfigured()) {
      return {
        success: false,
        error:
          'WhatsApp এখনো setup হয়নি — Twilio WhatsApp creds সেট করা নেই (TWILIO_WHATSAPP_FROM)। Sir-কে বলুন Twilio setup শেষ করে credentials দিতে।',
      }
    }
    if (process.env.WHATSAPP_CALL_ENABLED !== 'true') {
      return {
        success: false,
        error:
          'WhatsApp কল এখন বন্ধ আছে (kill switch)। চালু করতে আগে Twilio-তে WhatsApp Business Calling enable করুন, তারপর WHATSAPP_CALL_ENABLED=true সেট করুন।',
      }
    }

    const businessId = input.businessId === 'ALMA_TRADING' ? 'ALMA_TRADING' : 'ALMA_LIFESTYLE'
    const to = await resolveRecipientPhone(rawTo, businessId)
    if (!to) {
      return {
        success: false,
        error: `"${rawTo}"-এর WhatsApp নম্বর প্রোফাইলে পাওয়া যায়নি। নম্বরটা সরাসরি দিন (+8801…) অথবা স্টাফের ERP প্রোফাইলে ফোন নম্বর যোগ করুন।`,
      }
    }

    const res = await placeTwilioWaCall({ to, message })
    if (res.error) return { success: false, error: `WhatsApp কল করা যায়নি: ${res.error}` }
    return { success: true, data: { sid: res.sid, to, resolvedFrom: looksLikePhone(rawTo) ? 'number' : 'name', called: true } }
  },
}

export const WA_TOOLS: AgentTool[] = [send_whatsapp, get_wa_inbox, whatsapp_call]
