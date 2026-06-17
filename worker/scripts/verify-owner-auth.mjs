#!/usr/bin/env node
/**
 * Verifies owner Telegram auth works after dotenv load (ESM import order bug guard).
 * Run: cd worker && node scripts/verify-owner-auth.mjs
 */
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { getOwnerChatId, isOwnerChatId } from '../src/telegram/owner-id.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: join(__dir, '../.env'), override: true })

const ownerId = getOwnerChatId()
if (!ownerId) {
  console.error('FAIL: TELEGRAM_OWNER_CHAT_ID not set after dotenv')
  process.exit(1)
}

if (!isOwnerChatId(ownerId)) {
  console.error('FAIL: isOwnerChatId returned false for configured owner id')
  process.exit(1)
}

if (isOwnerChatId('999999999')) {
  console.error('FAIL: isOwnerChatId true for wrong chat id')
  process.exit(1)
}

console.log('PASS: owner auth — isOwnerChatId works for chat', ownerId)
