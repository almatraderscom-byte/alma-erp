/**
 * Staff nudges — text OR owner voice (ElevenLabs), never both.
 * Voice is used dynamically (~38%) to save cost while keeping human presence.
 */
import { sendVoiceMessage } from '../telegram/voice.mjs'
import { isElevenLabsAvailable } from '../tts-elevenlabs.mjs'

const VOICE_NUDGE_PROBABILITY = 0.38

export function buildDispatchVoiceHeadline(staffName, taskCount) {
  const first = String(staffName ?? 'ভাই').split(/\s+/)[0] ?? 'ভাই'
  const n = Math.max(1, Number(taskCount) || 1)
  return `আসসালামু আলাইকুম ${first} ভাই। আজ ${n}টি কাজ দেওয়া হয়েছে। বিস্তারিত টেলিগ্রামে দেখুন।`
}

export function shouldUseVoiceNudge() {
  if (!isElevenLabsAvailable()) return false
  return Math.random() < VOICE_NUDGE_PROBABILITY
}

/**
 * Send staff nudge as voice OR text — never both.
 * @param {import('telegraf').Telegraf|import('telegraf').Telegram} botOrApi
 * @param {string|number} chatId
 * @param {string} textMessage Full text (used when channel is text)
 * @param {string} [voiceScript] Shorter script for ElevenLabs (defaults to textMessage)
 * @param {object} [extra] Telegram sendMessage extra (e.g. reply_markup). Forces text channel so the buttons are tappable.
 */
export async function sendStaffNudge(botOrApi, chatId, textMessage, voiceScript, extra) {
  const api = botOrApi?.telegram ?? botOrApi
  // A reply_markup only makes sense on a text message — never send as voice then.
  const useVoice = !extra?.reply_markup && shouldUseVoiceNudge()
  const script = (voiceScript ?? textMessage).trim()

  if (useVoice) {
    await sendVoiceMessage(api, chatId, script, { elevenLabsOnly: true })
    return { channel: 'voice' }
  }

  await api.sendMessage(chatId, textMessage, extra)
  return { channel: 'text' }
}

export async function sendDispatchVoiceHeadline(botOrApi, chatId, staffName, taskCount) {
  if (!isElevenLabsAvailable()) return { skipped: true, reason: 'elevenlabs_not_configured' }
  const script = buildDispatchVoiceHeadline(staffName, taskCount)
  await sendVoiceMessage(botOrApi, chatId, script, { elevenLabsOnly: true })
  return { channel: 'voice', chars: script.length }
}
