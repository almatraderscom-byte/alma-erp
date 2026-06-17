/**
 * Voice note helpers for the Telegram bot.
 */
import { smartTts, isElevenLabsAvailable } from '../tts-elevenlabs.mjs'

const APP_URL   = () => (process.env.APP_URL ?? '').replace(/\/$/, '')
const INT_TOKEN = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

export async function transcribeVoiceNote(bot, fileId) {
  const fileInfo = await bot.telegram.getFile(fileId)
  const filePath = fileInfo.file_path
  const botToken = process.env.ASSISTANT_BOT_TOKEN
  const fileUrl  = `https://api.telegram.org/file/bot${botToken}/${filePath}`

  const audioRes = await fetch(fileUrl, { signal: AbortSignal.timeout(30_000) })
  if (!audioRes.ok) throw new Error(`Telegram file download failed: ${audioRes.status}`)
  const audioBuffer = Buffer.from(await audioRes.arrayBuffer())

  const transcribeRes = await fetch(`${APP_URL()}/api/assistant/internal/transcribe`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${INT_TOKEN()}`,
      'Content-Type': 'audio/ogg',
    },
    body: audioBuffer,
    signal: AbortSignal.timeout(60_000),
  })
  if (!transcribeRes.ok) {
    const err = await transcribeRes.text()
    throw new Error(`Transcription failed: ${err}`)
  }
  const data = await transcribeRes.json()
  return data.text ?? ''
}

function telegramApi(botOrApi) {
  return botOrApi?.telegram ?? botOrApi
}

/**
 * @param {import('telegraf').Telegraf|import('telegraf').Telegram} botOrApi
 * @param {string|number} chatId
 * @param {string} text
 * @param {{
 *   caption?: string,
 *   isSalah?: boolean,
 *   elevenLabsOnly?: boolean,
 *   useOwnerVoice?: boolean,
 *   voiceProfile?: 'staff' | 'male' | 'female',
 *   useElevenLabs?: boolean,
 * }} [options]
 */
export async function sendVoiceMessage(botOrApi, chatId, text, options = {}) {
  const api = telegramApi(botOrApi)
  const voiceProfile = options.voiceProfile ?? (options.elevenLabsOnly ? 'staff' : 'male')

  const mp3Buffer = await smartTts(text, {
    isSalah: options.isSalah,
    elevenLabsOnly: options.elevenLabsOnly,
    useOwnerVoice: options.useOwnerVoice,
    useElevenLabs: options.useElevenLabs,
    voiceProfile,
  })

  const extra = options.caption ? { caption: String(options.caption).slice(0, 200) } : {}
  const usedElevenLabs =
    !options.isSalah
    && Boolean(options.elevenLabsOnly || options.useElevenLabs)
    && isElevenLabsAvailable()

  if (usedElevenLabs) {
    await api.sendAudio(chatId, { source: mp3Buffer, filename: 'voice.mp3' }, extra)
    return
  }

  await api.sendVoice(chatId, { source: mp3Buffer }, extra)
}
