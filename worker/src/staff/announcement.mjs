/**
 * Staff announcement dispatcher — text + optional voice, no task tracking.
 */

import { loggedSendToStaff } from '../telegram/logged-send.mjs'
import { prepareStaffOutboundMessage } from '../staff/alma-team-voice.mjs'
import { sendVoiceMessage } from '../telegram/voice.mjs'
import { sendStaffWhatsApp } from './wa-notify.mjs'
import { createClient } from '@supabase/supabase-js'

function sb() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
}

/**
 * @param {object} params
 * @param {import('telegraf').Telegraf} params.bot
 * @param {object} params.payload
 */
export async function sendStaffAnnouncement({ bot, payload }) {
  const { message, staffChatIds, sendVoice, businessId } = payload ?? {}
  if (!message?.trim() || !staffChatIds?.length) {
    throw new Error('message and staffChatIds required')
  }

  const supabase = sb()
  const voice = sendVoice !== false
  // Default to Lifestyle for backward compat; agent passes the active project's
  // businessId so Telegram logs/outbox stay business-scoped.
  const payloadBusinessId =
    businessId === 'ALMA_TRADING' || businessId === 'ALMA_LIFESTYLE'
      ? businessId
      : 'ALMA_LIFESTYLE'
  let sentCount = 0

  for (const { id, name, chatId } of staffChatIds) {
    if (!chatId) continue
    try {
      const result = await loggedSendToStaff(bot.telegram, {
        supabase,
        staffId: id,
        staffName: name,
        businessId: payloadBusinessId,
        type: 'announcement',
        content: message,
        chatId,
        requiresAck: true,
      })
      if (!result.ok) {
        console.warn(`[announcement] Failed to send to ${name} (${chatId}):`, result.error)
        continue
      }

      if (voice) {
        try {
          await sendVoiceMessage(bot, chatId, prepareStaffOutboundMessage(message), { elevenLabsOnly: true })
        } catch (ttsErr) {
          console.warn(`[announcement] TTS failed for ${name}:`, ttsErr.message)
        }
      }

      // Best-effort WhatsApp copy (dormant unless STAFF_WHATSAPP_ENABLED + creds set).
      try {
        const wa = await sendStaffWhatsApp({ supabase, staffId: id, text: message })
        if (wa.sent) console.log(`[announcement] WhatsApp also sent to ${name}`)
      } catch { /* never break Telegram delivery */ }

      sentCount++
    } catch (err) {
      console.warn(`[announcement] Failed to send to ${name} (${chatId}):`, err.message)
    }
  }

  console.log(`[announcement] sent to ${sentCount}/${staffChatIds.length} staff`)
  return { sentCount, total: staffChatIds.length }
}
