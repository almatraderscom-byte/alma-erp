/**
 * Staff announcement dispatcher — text + optional voice, no task tracking.
 */

import { sendMarkdownSafe } from '../telegram/markdown-safe.mjs'
import { sendVoiceMessage } from '../telegram/voice.mjs'

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

  const voice = sendVoice !== false
  let sentCount = 0

  for (const { name, chatId } of staffChatIds) {
    if (!chatId) continue
    try {
      await sendMarkdownSafe(bot.telegram, chatId, message)

      if (voice) {
        try {
          await sendVoiceMessage(bot, chatId, message)
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
