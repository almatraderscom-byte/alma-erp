/**
 * Voice note helpers for the Telegram bot.
 *
 * Inbound:  OGG voice note → Whisper transcription via internal /api/assistant/internal/transcribe
 * Outbound: text → Google TTS (MP3) → send as Telegram voice note (audio/ogg is accepted by Telegram
 *           even as MP3 — Telegram auto-converts; send as audio/mpeg and let Telegram handle it)
 */

import { synthesizeSpeech } from '../tts.mjs'
import { smartTts, isElevenLabsAvailable } from '../tts-elevenlabs.mjs'

const APP_URL   = () => (process.env.APP_URL ?? '').replace(/\/$/, '')
const INT_TOKEN = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

/**
 * Downloads the voice note OGG from Telegram and transcribes it via Whisper.
 * @param {import('telegraf').Telegraf} bot
 * @param {string} fileId   Telegram file_id of the voice note
 * @returns {Promise<string>}  Transcribed text (may be empty)
 */
export async function transcribeVoiceNote(bot, fileId) {
  // Get file path from Telegram
  const fileInfo = await bot.telegram.getFile(fileId)
  const filePath = fileInfo.file_path
  const botToken = process.env.ASSISTANT_BOT_TOKEN
  const fileUrl  = `https://api.telegram.org/file/bot${botToken}/${filePath}`

  // Download the OGG
  const audioRes = await fetch(fileUrl)
  if (!audioRes.ok) throw new Error(`Telegram file download failed: ${audioRes.status}`)
  const audioBuffer = Buffer.from(await audioRes.arrayBuffer())

  // Raw audio body — reliable server-to-server (multipart field names vary across runtimes).
  const transcribeRes = await fetch(`${APP_URL()}/api/assistant/internal/transcribe`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${INT_TOKEN()}`,
      'Content-Type': 'audio/ogg',
    },
    body: audioBuffer,
  })
  if (!transcribeRes.ok) {
    const err = await transcribeRes.text()
    throw new Error(`Transcription failed: ${err}`)
  }
  const data = await transcribeRes.json()
  return data.text ?? ''
}

/** Telegraf instance or ctx.telegram API object */
function telegramApi(botOrApi) {
  return botOrApi?.telegram ?? botOrApi
}

/**
 * Synthesizes text to speech and sends it as a Telegram voice note.
 * Uses ElevenLabs (owner's cloned voice) for staff messages when available.
 * Falls back to Google TTS for Salah or when ElevenLabs is not configured.
 *
 * @param {import('telegraf').Telegraf|import('telegraf').Telegram} botOrApi
 * @param {string|number} chatId
 * @param {string} text
 * @param {{ caption?: string, useOwnerVoice?: boolean, isSalah?: boolean }} [options]
 */
export async function sendVoiceMessage(botOrApi, chatId, text, options = {}) {
  const api = telegramApi(botOrApi)
  const useOwner = options.isSalah ? false : (options.useOwnerVoice ?? isElevenLabsAvailable())
  const mp3Buffer = await smartTts(text, { useOwnerVoice: useOwner })
  const extra = options.caption ? { caption: String(options.caption).slice(0, 200) } : {}
  await api.sendVoice(chatId, { source: mp3Buffer }, extra)
}
