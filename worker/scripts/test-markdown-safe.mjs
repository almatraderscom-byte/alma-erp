#!/usr/bin/env node
/**
 * Verifies replyMarkdownSafe falls back when Telegram rejects Markdown entities.
 * Simulates the Eyafi task summary with thread IDs (t_1648631293023028).
 */
import { replyMarkdownSafe, sendMarkdownSafe } from '../src/telegram/markdown-safe.mjs'

const PARSE_ERR = new Error("400: Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 224")

const summary =
  '### Eyafi task\nthread `t_1648631293023028`\nthread `t_1331293722522059`'

let calls = []
const ctx = {
  reply: async (text, opts) => {
    calls.push({ text, opts })
    if (calls.length === 1 && opts?.parse_mode === 'Markdown') throw PARSE_ERR
    return { message_id: 1 }
  },
}

await replyMarkdownSafe(ctx, `📋 *অনুমোদন প্রয়োজন*\n${summary}`, {
  reply_markup: { inline_keyboard: [[{ text: '✅', callback_data: 'approve:x' }]] },
})

if (calls.length !== 2) throw new Error(`expected 2 calls, got ${calls.length}`)
if (calls[0].opts.parse_mode !== 'Markdown') throw new Error('first call should use Markdown')
if (calls[1].opts.parse_mode !== undefined) throw new Error('fallback must omit parse_mode')
if (!calls[1].opts.reply_markup) throw new Error('fallback must keep reply_markup')

let sendCalls = []
const telegram = {
  sendMessage: async (chatId, text, opts) => {
    sendCalls.push({ chatId, text, opts })
    if (sendCalls.length === 1 && opts?.parse_mode === 'Markdown') throw PARSE_ERR
    return { message_id: 2 }
  },
}
await sendMarkdownSafe(telegram, 123, summary, {})
if (sendCalls.length !== 2) throw new Error(`sendMarkdownSafe: expected 2 calls, got ${sendCalls.length}`)

console.log('✅ markdown-safe: Markdown failure → plain fallback with buttons preserved')
