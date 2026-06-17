#!/usr/bin/env node
/**
 * Eleven v3 voice tour — premade voices (Adam alternatives) in Bangla.
 */
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { installTelegramProxy } from '../src/telegram-proxy.mjs'
import { Telegraf } from 'telegraf'

const __dir = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: join(__dir, '../.env'), override: true })
installTelegramProxy()

const TEXT =
  'স্যার, আসসালামু আলাইকুম। আমি আপনার ব্যবসার সহকারী। আজ অফিসে তিনটি জরুরি কাজ আছে। সময়মতো শেষ করলে ভালো হবে। ধন্যবাদ।'

/** Male premade voices — good candidates for Bangla on eleven_v3 */
const VOICES = [
  { id: 'pNInz6obpgDQGcFmaJgB', name: '১. Adam — Dominant, Firm (reference)' },
  { id: 'JBFqnCBsd6RMkjVDRZzb', name: '২. George — Warm Storyteller' },
  { id: 'nPczCjzI2devNBz1zQrb', name: '৩. Brian — Deep, Comforting' },
  { id: 'onwK4e9ZLuTAKqWW03F9', name: '৪. Daniel — Steady Broadcaster' },
  { id: 'cjVigY5qzO86Huf0OWal', name: '৫. Eric — Smooth, Trustworthy' },
  { id: 'SAz9YHcvj6GT2YYXdXww', name: '৬. River — Relaxed, Neutral' },
  { id: 'iP95p4xoKVk53GoZ742B', name: '৭. Chris — Charming, Down-to-Earth' },
  { id: 'pqHfZKP75CvOlQylNhV4', name: '৮. Bill — Wise, Mature' },
  { id: 'bIHbv24MWmeRgasZH58o', name: '৯. Will — Relaxed Optimist' },
  { id: 'CwhRBWXzGAHq8TQ4Fs17', name: '১০. Roger — Laid-Back, Resonant' },
  { id: 'IKne3meq5aSn9XLyUdCD', name: '১১. Charlie — Deep, Confident' },
  { id: 'N2lVS1w4EtoT3dr4eOWO', name: '১২. Callum — Husky' },
]

async function synth(apiKey, voiceId) {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey, Accept: 'audio/mpeg' },
      body: JSON.stringify({
        text: TEXT,
        model_id: 'eleven_v3',
        voice_settings: { stability: 0.5, similarity_boost: 0.75, use_speaker_boost: true },
      }),
      signal: AbortSignal.timeout(45_000),
    },
  )
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 100)}`)
  return Buffer.from(await res.arrayBuffer())
}

async function main() {
  const apiKey = process.env.ELEVENLABS_API_KEY
  const token = process.env.ASSISTANT_BOT_TOKEN
  const chat = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!apiKey || !token || !chat) process.exit(1)

  const apiRoot = (process.env.TELEGRAM_API_BASE ?? '').replace(/\/$/, '') || 'https://api.telegram.org'
  const bot = new Telegraf(token, { telegram: { apiRoot } })

  await bot.telegram.sendMessage(
    chat,
    '🎙 Eleven v3 — Adam ছাড়া আরও ১১টা male voice (বাংলা টেস্ট)\n\nযেটা সবচেয়ে ভালো লাগে নম্বর জানাবেন।',
  )

  for (const v of VOICES) {
    try {
      console.log(v.name)
      const buf = await synth(apiKey, v.id)
      await bot.telegram.sendMessage(chat, `🔊 ${v.name}`)
      await bot.telegram.sendAudio(chat, { source: buf, filename: 'bangla-voice.mp3' })
      await new Promise((r) => setTimeout(r, 900))
    } catch (e) {
      console.warn('skip', v.name, e.message)
      await bot.telegram.sendMessage(chat, `⚠️ ${v.name} — তৈরি হয়নি`)
    }
  }
  console.log('✅ done')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
