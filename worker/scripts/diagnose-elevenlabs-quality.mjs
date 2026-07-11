#!/usr/bin/env node
/**
 * A/B diagnose: why ElevenLabs Adam sounds worse than playground on Telegram.
 */
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { installTelegramProxy } from '../src/telegram-proxy.mjs'
import { Telegraf } from 'telegraf'
import { prepareBanglaForElevenLabs, synthesizeElevenLabs } from '../src/tts-elevenlabs.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: join(__dir, '../.env'), override: true })
installTelegramProxy()

const ADAM = 'pNInz6obpgDQGcFmaJgB'
const TEXT = 'আপনার বাংলা টেক্সট এখানে লিখুন। বস, আসসালামু আলাইকুম। এটি অ্যাডাম ভয়েসের পরীক্ষা।'

async function playgroundExact(apiKey, text) {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ADAM}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': apiKey,
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.62, similarity_boost: 0.8, style: 0, use_speaker_boost: true },
      }),
      signal: AbortSignal.timeout(45_000),
    },
  )
  if (!res.ok) throw new Error(`playground: ${res.status} ${await res.text()}`)
  return Buffer.from(await res.arrayBuffer())
}

async function main() {
  const apiKey = process.env.ELEVENLABS_API_KEY
  const token = process.env.ASSISTANT_BOT_TOKEN
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!apiKey || !token || !ownerChatId) process.exit(1)

  const apiRoot = (process.env.TELEGRAM_API_BASE ?? '').replace(/\/$/, '') || 'https://api.telegram.org'
  const bot = new Telegraf(token, { telegram: { apiRoot } })

  const prepared = prepareBanglaForElevenLabs(TEXT)
  const playgroundBuf = await playgroundExact(apiKey, TEXT)
  const ourBuf = await synthesizeElevenLabs(TEXT)

  await bot.telegram.sendMessage(
    ownerChatId,
    '🔬 ডায়াগনোসিস — একই অ্যাডাম ভয়েস, ৩টা পার্থক্য:\n\n' +
      'A = Playground exact (raw text + HD MP3)\n' +
      'B = Playground exact কিন্তু Telegram voice note (compress)\n' +
      'C = আমাদের পুরনো pipeline (text prep + voice note)',
  )

  await bot.telegram.sendMessage(ownerChatId, `📝 Raw text: ${TEXT}`)
  await bot.telegram.sendMessage(ownerChatId, `📝 Our prep changed to: ${prepared}`)

  await bot.telegram.sendMessage(ownerChatId, 'A — Playground exact → Audio file (HD, compress নেই)')
  await bot.telegram.sendAudio(ownerChatId, { source: playgroundBuf, filename: 'playground-adam.mp3' })

  await bot.telegram.sendMessage(ownerChatId, 'B — Playground exact → Voice note (Telegram compress)')
  await bot.telegram.sendVoice(ownerChatId, { source: playgroundBuf })

  await bot.telegram.sendMessage(ownerChatId, 'C — আমাদের pipeline → Voice note')
  await bot.telegram.sendVoice(ownerChatId, { source: ourBuf })

  console.log('bytes playground', playgroundBuf.length, 'our', ourBuf.length)
  console.log('text same after prep?', TEXT === prepared)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
