#!/usr/bin/env node
/**
 * Compare ElevenLabs voices for Bangla clarity — sends labeled samples to owner Telegram.
 * Usage: cd worker && node scripts/test-bangla-voice-compare.mjs
 */
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { installTelegramProxy } from '../src/telegram-proxy.mjs'
import { Telegraf } from 'telegraf'
import { prepareBanglaForElevenLabs } from '../src/tts-elevenlabs.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: join(__dir, '../.env'), override: true })
installTelegramProxy()

const API_KEY = () => process.env.ELEVENLABS_API_KEY ?? ''
const BASE = 'https://api.elevenlabs.io/v1'

/** Pure Bangla — real staff-dispatch style sentence */
const TEST_TEXT =
  'স্যার, আসসালামু আলাইকুম। আমি আপনার ব্যবসার সহকারী। আজ অফিসে তিনটি জরুরি কাজ আছে। সময়মতো শেষ করলে ভালো হবে। ধন্যবাদ।'

/** Bengali-capable voices on this account + current default */
const CANDIDATES = [
  {
    label: '১. বিজু এস — বাংলা প্রফেশনাল (সেরা ক্যান্ডিডেট)',
    voiceId: 'FhOnCtjmaAIRIS1Dg2bk',
    model_id: 'eleven_multilingual_v2',
    voice_settings: { stability: 0.55, similarity_boost: 0.85, style: 0, use_speaker_boost: true },
  },
  {
    label: '২. বিজু এস — স্থিতিশীল উচ্চারণ',
    voiceId: 'FhOnCtjmaAIRIS1Dg2bk',
    model_id: 'eleven_multilingual_v2',
    voice_settings: { stability: 0.68, similarity_boost: 0.78, style: 0, use_speaker_boost: true },
  },
  {
    label: '৩. টেস্ট মারুফ — আপনার ক্লোন',
    voiceId: 'Z0rjYjGcQoE8iaTf7Gm6',
    model_id: 'eleven_multilingual_v2',
    voice_settings: { stability: 0.62, similarity_boost: 0.8, style: 0, use_speaker_boost: true },
  },
  {
    label: '৪. অ্যাডাম প্রিমেড (বর্তমান)',
    voiceId: 'pNInz6obpgDQGcFmaJgB',
    model_id: 'eleven_multilingual_v2',
    voice_settings: { stability: 0.62, similarity_boost: 0.8, style: 0, use_speaker_boost: true },
  },
]

async function synthesize(candidate) {
  const text = prepareBanglaForElevenLabs(TEST_TEXT)
  const res = await fetch(`${BASE}/text-to-speech/${candidate.voiceId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key': API_KEY(),
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: candidate.model_id,
      voice_settings: candidate.voice_settings,
    }),
    signal: AbortSignal.timeout(45_000),
  })
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`${candidate.label}: ${res.status} ${err.slice(0, 120)}`)
  }
  return Buffer.from(await res.arrayBuffer())
}

async function main() {
  const token = process.env.ASSISTANT_BOT_TOKEN
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!API_KEY()) {
    console.error('ELEVENLABS_API_KEY missing')
    process.exit(1)
  }
  if (!token || !ownerChatId) {
    console.error('Telegram env missing')
    process.exit(1)
  }

  const apiRoot = (process.env.TELEGRAM_API_BASE ?? '').replace(/\/$/, '') || 'https://api.telegram.org'
  const bot = new Telegraf(token, { telegram: { apiRoot } })

  await bot.telegram.sendMessage(
    ownerChatId,
    '🎙 বাংলা ভয়েস তুলনা — নিচে ৪টা স্যাম্পল। যেটা সবচেয়ে পরিষ্কার শুনতে পাবেন সেটার নম্বর জানাবেন।',
  )

  let best = { label: '', bytes: 0 }

  for (const c of CANDIDATES) {
    console.log(`[compare] ${c.label}...`)
    try {
      const buf = await synthesize(c)
      console.log(`  → ${buf.length} bytes`)
      await bot.telegram.sendMessage(ownerChatId, `🔊 ${c.label}`)
      await bot.telegram.sendVoice(ownerChatId, { source: buf })
      if (buf.length > best.bytes) best = { label: c.label, bytes: buf.length, voiceId: c.voiceId }
    } catch (err) {
      console.warn(`  skip: ${err.message}`)
      await bot.telegram.sendMessage(ownerChatId, `⚠️ ${c.label} — তৈরি হয়নি (${err.message.slice(0, 60)})`)
    }
    await new Promise((r) => setTimeout(r, 1200))
  }

  await bot.telegram.sendMessage(
    ownerChatId,
    '✅ আমার সুপারিশ: ১ নম্বর বিজু এস (বাংলা প্রফেশনাল) — ElevenLabs-এ সবচেয়ে পরিষ্কার বাংলা। যেটা ভালো লাগে নম্বর জানাবেন।',
  )
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
