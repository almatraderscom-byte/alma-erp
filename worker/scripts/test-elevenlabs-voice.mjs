#!/usr/bin/env node
/**
 * Send a test ElevenLabs voice note to owner Telegram.
 * Usage (VPS): cd /opt/alma-erp/worker && node scripts/test-elevenlabs-voice.mjs
 */
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { writeFileSync, unlinkSync } from 'fs'
import { execFileSync } from 'child_process'
import { synthesizeElevenLabs } from '../src/tts-elevenlabs.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: join(__dir, '../.env'), override: true })

const TEST_TEXT =
  'স্যার, এটা ElevenLabs টেস্ট ভয়েস। model eleven multilingual v two। stability পয়েন্ট পাঁচ, similarity boost সাত পয়েন্ট পঁচাত্তর। আওয়াজ ক্লিয়ার শুনতে পাচ্ছেন কিনা বলবেন।'

async function main() {
  const token = process.env.ASSISTANT_BOT_TOKEN
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!token || !ownerChatId) {
    console.error('ASSISTANT_BOT_TOKEN or TELEGRAM_OWNER_CHAT_ID missing')
    process.exit(1)
  }

  console.log('[test-voice] synthesizing via ElevenLabs...')
  const mp3Buffer = await synthesizeElevenLabs(TEST_TEXT)
  console.log(`[test-voice] synthesized ${mp3Buffer.length} bytes`)

  const tmpPath = '/tmp/alma-elevenlabs-test.mp3'
  writeFileSync(tmpPath, mp3Buffer)

  try {
    const out = execFileSync(
      'curl',
      [
        '-sS', '--max-time', '90', '--ipv4',
        '-F', `chat_id=${ownerChatId}`,
        '-F', `voice=@${tmpPath}`,
        `https://api.telegram.org/bot${token}/sendVoice`,
      ],
      { encoding: 'utf8' },
    )
    const parsed = JSON.parse(out)
    if (!parsed.ok) {
      console.error('[test-voice] Telegram error:', parsed)
      process.exit(1)
    }
    console.log('✅ Test voice sent to owner Telegram (message_id:', parsed.result?.message_id, ')')
  } finally {
    try { unlinkSync(tmpPath) } catch { /* ignore */ }
  }
}

main().catch((err) => {
  console.error('Test voice failed:', err.message)
  process.exit(1)
})
