#!/usr/bin/env node
/**
 * Final Bangla TTS shootout: eleven_v3 vs multilingual_v2 vs Google TTS
 */
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { installTelegramProxy } from '../src/telegram-proxy.mjs'
import { Telegraf } from 'telegraf'
import { synthesizeSpeech } from '../src/tts.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: join(__dir, '../.env'), override: true })
installTelegramProxy()

const ADAM = 'pNInz6obpgDQGcFmaJgB'
const CLONE = 'Z0rjYjGcQoE8iaTf7Gm6'
const TEXT = 'স্যার, আসসালামু আলাইকুম। আমি আপনার ব্যবসার সহকারী। আজ অফিসে তিনটি জরুরি কাজ আছে। সময়মতো শেষ করলে ভালো হবে।'

async function el(apiKey, { model_id, voiceId, label }) {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey, Accept: 'audio/mpeg' },
      body: JSON.stringify({
        text: TEXT,
        model_id,
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true },
      }),
      signal: AbortSignal.timeout(45_000),
    },
  )
  if (!res.ok) throw new Error(`${label}: ${res.status} ${(await res.text()).slice(0, 120)}`)
  return Buffer.from(await res.arrayBuffer())
}

async function main() {
  const apiKey = process.env.ELEVENLABS_API_KEY
  const token = process.env.ASSISTANT_BOT_TOKEN
  const chat = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!apiKey || !token || !chat) process.exit(1)

  const apiRoot = (process.env.TELEGRAM_API_BASE ?? '').replace(/\/$/, '') || 'https://api.telegram.org'
  const bot = new Telegraf(token, { telegram: { apiRoot } })

  const samples = [
    {
      label: '১. Eleven v3 + Adam (বাংলা সাপোর্ট ✅ — সেরা ElevenLabs অপশন)',
      run: () => el(apiKey, { model_id: 'eleven_v3', voiceId: ADAM, label: 'v3' }),
    },
    {
      label: '২. Multilingual v2 + Adam (বাংলা সাপোর্ট ❌ — আমরা এটাই ব্যবহার করছিলাম)',
      run: () => el(apiKey, { model_id: 'eleven_multilingual_v2', voiceId: ADAM, label: 'mv2' }),
    },
    {
      label: '৩. Eleven v3 + আপনার ক্লোন (Test Maruf)',
      run: () => el(apiKey, { model_id: 'eleven_v3', voiceId: CLONE, label: 'v3-clone' }),
    },
    {
      label: '৪. Google TTS bn-IN Charon (আমাদের আগের সিস্টেম)',
      run: () => synthesizeSpeech(TEXT),
    },
  ]

  await bot.telegram.sendMessage(
    chat,
    '🔬 গবেষণা ফলাফল — বাংলা TTS তুলনা\n\n' +
      'মূল ভুল: eleven_multilingual_v2-তে বাংলা নেই (২৯টা ভাষা)।\n' +
      'Playground এখন Eleven v3 ব্যবহার করে (৭০+ ভাষা, বাংলা আছে)।\n' +
      'Starter plan-এ v3 API কাজ করে ✅\n\n' +
      'নিচে ৪টা sample শুনুন:',
  )

  for (const s of samples) {
    try {
      const buf = await s.run()
      await bot.telegram.sendMessage(chat, `🔊 ${s.label}\n(${buf.length} bytes)`)
      await bot.telegram.sendAudio(chat, { source: buf, filename: 'bangla-test.mp3' })
      await new Promise((r) => setTimeout(r, 1000))
    } catch (e) {
      await bot.telegram.sendMessage(chat, `⚠️ ${s.label} — fail: ${e.message}`)
    }
  }

  await bot.telegram.sendMessage(
    chat,
    '📌 সত্যি কথা:\n' +
      '• ElevenLabs-এ Bangladeshi accent আলাদা নেই — সবাই Indian Bengali (ben)\n' +
      '• Adam + v3 = playground-এর মতো\n' +
      '• আপনার clone ইংরেজিতে train হলে বাংলা খারাপ হবে\n' +
      '• Google Charon = বাংলা উচ্চারণ পরিষ্কার, কিন্তু Indian accent\n\n' +
      'যেটা সবচেয়ে ভালো লাগে নম্বর জানান।',
  )
  console.log('done')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
