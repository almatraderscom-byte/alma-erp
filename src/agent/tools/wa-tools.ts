import type { AgentTool } from './registry'
import { prisma } from '@/lib/prisma'
import { sendTwilioWaText, twilioWaConfigured } from '@/agent/lib/wa/twilio-wa'

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

export const WA_TOOLS: AgentTool[] = [send_whatsapp]
