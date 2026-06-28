import type { AgentTool } from './registry'
import { sendTwilioWaText, twilioWaConfigured } from '@/agent/lib/wa/twilio-wa'

/**
 * Send a WhatsApp text via the business WhatsApp (Twilio path). Dormant + safe:
 * returns a clear error when Twilio WhatsApp isn't configured, and a kill switch
 * (WHATSAPP_SEND_ENABLED=true) must be on before anything is sent — so setting the
 * creds alone never makes the agent send until the owner deliberately enables it.
 */
const send_whatsapp: AgentTool = {
  name: 'send_whatsapp',
  description:
    'Sends a WhatsApp TEXT message via the business WhatsApp number (Twilio). ' +
    'Use when Sir asks to send or TEST a WhatsApp message to a number. ' +
    'to = phone in international format (e.g. +8801712345678). ' +
    'Owner-directed sends only — never unsolicited customer marketing.',
  input_schema: {
    type: 'object' as const,
    properties: {
      to: { type: 'string', description: 'Recipient phone, international format, e.g. +8801712345678' },
      message: { type: 'string', description: 'Message text (max 1600 chars)' },
    },
    required: ['to', 'message'],
  },
  handler: async (input) => {
    const to = String(input.to ?? '').trim()
    const message = String(input.message ?? '').trim()
    if (!to || !message) return { success: false, error: 'to ও message — দুটোই দরকার।' }
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
    const res = await sendTwilioWaText({ to, body: message })
    if (res.error) return { success: false, error: `WhatsApp পাঠানো যায়নি: ${res.error}` }
    return { success: true, data: { sid: res.sid, to, sent: true } }
  },
}

export const WA_TOOLS: AgentTool[] = [send_whatsapp]
