#!/usr/bin/env node
/** Confirm Charlie (staff) + River (female) routing — sends 2 samples to owner Telegram. */
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { installTelegramProxy } from '../src/telegram-proxy.mjs'
import { Telegraf } from 'telegraf'
import { sendVoiceMessage } from '../src/telegram/voice.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: join(__dir, '../.env'), override: true })
installTelegramProxy()

const STAFF_TEXT = 'আসসালামু আলাইকুম ইয়াফি ভাই। আজ তিনটি কাজ দেওয়া হয়েছে। বিস্তারিত টেলিগ্রামে দেখুন।'
const FEMALE_TEXT = 'বস, আসসালামু আলাইকুম। এটি রিভার ফিমেল ভয়েসের পরীক্ষা।'

async function main() {
  const token = process.env.ASSISTANT_BOT_TOKEN
  const chat = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!token || !chat) process.exit(1)
  const apiRoot = (process.env.TELEGRAM_API_BASE ?? '').replace(/\/$/, '') || 'https://api.telegram.org'
  const bot = new Telegraf(token, { telegram: { apiRoot } })

  await bot.telegram.sendMessage(chat, '✅ Voice routing সেট — ২টা confirm sample:')
  await bot.telegram.sendMessage(chat, '১. Charlie — স্টাফ announcement (default)')
  await sendVoiceMessage(bot, chat, STAFF_TEXT, { elevenLabsOnly: true, voiceProfile: 'staff' })
  await bot.telegram.sendMessage(chat, '২. River — female (যখন আপনি female voice বলবেন)')
  await sendVoiceMessage(bot, chat, FEMALE_TEXT, { useOwnerVoice: true, voiceProfile: 'female' })
  console.log('done')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
