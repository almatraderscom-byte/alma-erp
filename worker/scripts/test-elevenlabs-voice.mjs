#!/usr/bin/env node
/**
 * Send a test ElevenLabs voice note to owner Telegram.
 * Usage (VPS): cd /opt/alma-erp/worker && node scripts/test-elevenlabs-voice.mjs
 */
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { Telegraf } from 'telegraf'
import { sendVoiceMessage } from '../src/telegram/voice.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: join(__dir, '../.env'), override: true })

const TEST_TEXT =
  'স্যার, এটা ElevenLabs টেস্ট ভয়েস। model eleven multilingual v two, stability পয়েন্ট পাঁচ, similarity boost পয়েন্ট সাত পয়েন্ট পঁচাত্তর। আওয়াজ ক্লিয়ার শুনতে পাচ্ছেন কিনা বলবেন।'

async function main() {
  const token = process.env.ASSISTANT_BOT_TOKEN
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!token || !ownerChatId) {
    console.error('ASSISTANT_BOT_TOKEN or TELEGRAM_OWNER_CHAT_ID missing')
    process.exit(1)
  }

  const bot = new Telegraf(token)
  await sendVoiceMessage(bot, ownerChatId, TEST_TEXT, { elevenLabsOnly: true })
  console.log('✅ Test voice sent to owner Telegram')
}

main().catch((err) => {
  console.error('Test voice failed:', err.message)
  process.exit(1)
})
