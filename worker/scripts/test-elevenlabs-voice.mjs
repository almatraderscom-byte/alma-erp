#!/usr/bin/env node
/**
 * Send Bangla-only ElevenLabs test voice notes to owner Telegram.
 * Usage (VPS): cd /opt/alma-erp/worker && node scripts/test-elevenlabs-voice.mjs
 */
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { installTelegramProxy } from '../src/telegram-proxy.mjs'
import { Telegraf } from 'telegraf'
import { sendVoiceMessage } from '../src/telegram/voice.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: join(__dir, '../.env'), override: true })
installTelegramProxy()

/** Pure Bangla — playground-style Adam test */
const TEST_SAMPLES = [
  'আপনার বাংলা টেক্সট এখানে লিখুন। বস, আসসালামু আলাইকুম। এটি অ্যাডাম ভয়েসের পরীক্ষা।',
]

async function main() {
  const token = process.env.ASSISTANT_BOT_TOKEN
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!token || !ownerChatId) {
    console.error('ASSISTANT_BOT_TOKEN or TELEGRAM_OWNER_CHAT_ID missing')
    process.exit(1)
  }

  const apiRoot = (process.env.TELEGRAM_API_BASE ?? '').replace(/\/$/, '') || 'https://api.telegram.org'
  const bot = new Telegraf(token, { telegram: { apiRoot } })

  for (let i = 0; i < TEST_SAMPLES.length; i++) {
    console.log(`[test-voice] sending sample ${i + 1}/${TEST_SAMPLES.length}...`)
    await sendVoiceMessage(bot, ownerChatId, TEST_SAMPLES[i], { elevenLabsOnly: true })
    if (i < TEST_SAMPLES.length - 1) await new Promise((r) => setTimeout(r, 1500))
  }
  console.log('✅ Bangla test voices sent to owner Telegram')
}

main().catch((err) => {
  console.error('Test voice failed:', err.message)
  process.exit(1)
})
