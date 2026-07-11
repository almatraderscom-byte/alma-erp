#!/usr/bin/env node
/**
 * Manual notification smoke test — Telegram + ntfy + optional Twilio call.
 * Usage: cd worker && node scripts/test-notify.mjs
 */
import { config } from 'dotenv'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { Telegraf } from 'telegraf'
import { setTelegramForNotify, notify } from '../src/notify/index.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dir, '../.env') })

const token = process.env.ASSISTANT_BOT_TOKEN
const owner = process.env.TELEGRAM_OWNER_CHAT_ID
if (!token || !owner) {
  console.error('ASSISTANT_BOT_TOKEN and TELEGRAM_OWNER_CHAT_ID required')
  process.exit(1)
}

const bot = new Telegraf(token)
setTelegramForNotify(bot, owner)

const ts = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' })

console.log('[test] Tier 2 — Telegram + ntfy general + ntfy critical...')
const r1 = await notify({
  tier: 2,
  title: 'ALMA Test Notification',
  message: `বস, এটি একটি টেস্ট (${ts} Dhaka)। ntfy + Telegram যাচাই।`,
  category: 'salah',
  voice: false,
})
console.log(JSON.stringify(r1, null, 2))

console.log('[test] Tier 3 — voice + Twilio call...')
const r2 = await notify({
  tier: 3,
  title: 'ALMA Test Call',
  message: 'বস, এটি একটি টেস্ট কল। নোটিফিকেশন সিস্টেম যাচাই হচ্ছে।',
  category: 'urgent',
  voice: true,
})
console.log(JSON.stringify(r2, null, 2))

const ok =
  r1.statuses?.telegram === 'sent'
  && r1.statuses?.ntfy_general === 'sent'
  && r1.statuses?.ntfy_critical === 'sent'

if (r2.statuses?.twilio_call?.startsWith('sent:')) {
  console.log('[test] Twilio call placed:', r2.statuses.twilio_call)
} else {
  console.warn('[test] Twilio call skipped/failed:', r2.statuses?.twilio_call)
}

process.exit(ok ? 0 : 1)
