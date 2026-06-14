/**
 * Staff announcement dispatcher — text + optional voice, no task tracking.
 */

import { loggedSendToStaff } from '../telegram/logged-send.mjs'
import { prepareStaffOutboundMessage } from '../staff/alma-team-voice.mjs'
import { sendVoiceMessage } from '../telegram/voice.mjs'
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
  const { message, staffChatIds, sendVoice } = payload ?? {}
  if (!message?.trim() || !staffChatIds?.length) {
    throw new Error('message and staffChatIds required')
  }

  const supabase = sb()
  const voice = sendVoice !== false
  let sentCount = 0

  for (const { id, name, chatId } of staffChatIds) {
    if (!chatId) continue
    try {
      const result = await loggedSendToStaff(bot.telegram, {
        supabase,
        staffId: id,
        staffName: name,
        businessId: 'ALMA_LIFESTYLE',
        type: 'announcement',
        content: message,
        chatId,
      })
      if (!result.ok) {
        console.warn(`[announcement] Failed to send to ${name} (${chatId}):`, result.error)
        continue
      }

      if (voice) {
        try {
          await sendVoiceMessage(bot, chatId, prepareStaffOutboundMessage(message))
        } catch (ttsErr) {
          console.warn(`[announcement] TTS failed for ${name}:`, ttsErr.message)
        }
      }
      sentCount++
    } catch (err) {
      console.warn(`[announcement] Failed to send to ${name} (${chatId}):`, err.message)
    }
  }

  console.log(`[announcement] sent to ${sentCount}/${staffChatIds.length} staff`)
  return { sentCount, total: staffChatIds.length }
}
