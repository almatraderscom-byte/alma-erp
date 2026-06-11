/**
 * ALMA Assistant Telegram Bot — Telegraf long-polling.
 *
 * Owner-only: messages from TELEGRAM_OWNER_CHAT_ID go to the agent.
 * Unknown chat IDs receive a Bangla rejection message + their ID (for Phase 6 staff onboarding).
 *
 * Commands:
 *   /new    — start a new conversation
 *   /chats  — pick from the 5 most recent conversations
 *   /help   — usage guide (Bangla)
 *   /staff link <name> <chatId> — bind a staff member's Telegram ID (owner only)
 *
 * Confirm cards from pending actions render as inline keyboard buttons.
 */

import { Telegraf } from 'telegraf'
import { transcribeVoiceNote, sendVoiceMessage } from './voice.mjs'
import { setTelegramForNotify } from '../notify/index.mjs'

const APP_URL   = process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = process.env.AGENT_INTERNAL_TOKEN ?? ''
const OWNER_ID  = String(process.env.TELEGRAM_OWNER_CHAT_ID ?? '')

// Per-owner conversation state (in-memory — resets on worker restart, which is fine)
const ownerState = {
  conversationId: null, // null = auto-assign (daily conversation)
}

function isOwner(chatId) {
  return OWNER_ID && String(chatId) === OWNER_ID
}

// ── Daily conversation helper ──────────────────────────────────────────────

async function getDailyConversationId() {
  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const title = `Telegram ${today}`

  // Try to find an existing conversation for today
  const listRes = await fetch(`${APP_URL}/api/assistant/internal/telegram-conversation?date=${today}`, {
    headers: { Authorization: `Bearer ${INT_TOKEN}` },
  })
  if (listRes.ok) {
    const data = await listRes.json()
    if (data.conversationId) return data.conversationId
  }

  // Create a new one — the chat route creates conversations automatically on first message
  // We return null here and let the chat endpoint create it; then cache the returned id.
  return null
}

// ── Send a message to the agent backend ───────────────────────────────────

async function sendToAgent(userMessage, conversationId) {
  const res = await fetch(`${APP_URL}/api/assistant/chat?stream=false`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${INT_TOKEN}`,
    },
    body: JSON.stringify({ message: userMessage, conversationId: conversationId ?? undefined }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Agent API ${res.status}: ${err}`)
  }
  return await res.json()
  // Returns { conversationId, text, pendingCards }
}

// ── Telegram message splitting (4096 char limit) ───────────────────────────

function splitMessage(text, limit = 4096) {
  const chunks = []
  let remaining = text
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf('\n', limit)
    if (splitAt < limit * 0.5) splitAt = limit
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).trimStart()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

// Convert markdown to Telegram-safe MarkdownV2 (basic conversion)
function toTelegramMd(text) {
  // Escape MarkdownV2 special chars, then apply basic formatting
  return text
    .replace(/[_*[\]()~`>#+=|{}.!\\-]/g, (c) => `\\${c}`)
    .replace(/\\\*\\\*(.*?)\\\*\\\*/g, '*$1*') // re-apply **bold** → *bold*
    .replace(/\\\*(.*?)\\\*/g, '_$1_')           // *italic* → _italic_
}

// ── Handle text message from owner ────────────────────────────────────────

async function handleOwnerText(ctx, text) {
  // Use current conversation or get/create daily one
  let convId = ownerState.conversationId
  if (!convId) convId = await getDailyConversationId()

  let typingInterval
  try {
    typingInterval = setInterval(() => {
      ctx.sendChatAction('typing').catch(() => {})
    }, 4000)
    await ctx.sendChatAction('typing')

    const result = await sendToAgent(text, convId)

    clearInterval(typingInterval)

    // Cache the conversation id from the response
    if (result.conversationId) {
      ownerState.conversationId = result.conversationId
    }

    const replyText = result.text || '(কোনো উত্তর নেই)'

    // Send text reply (split if needed)
    const chunks = splitMessage(replyText)
    for (const chunk of chunks) {
      await ctx.reply(chunk, { parse_mode: 'Markdown' }).catch(() => ctx.reply(chunk))
    }

    // Send voice note reply
    if (process.env.GOOGLE_TTS_CREDENTIALS) {
      try {
        await sendVoiceMessage(ctx.telegram, ctx.chat.id, replyText)
      } catch (ttsErr) {
        console.warn('[telegram] TTS voice reply failed:', ttsErr.message)
      }
    }

    // Send confirm cards as inline keyboard buttons
    for (const card of result.pendingCards ?? []) {
      await ctx.reply(
        `📋 *অনুমোদন প্রয়োজন*\n${card.summary}`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ অনুমোদন', callback_data: `approve:${card.pendingActionId}` },
              { text: '❌ বাতিল',   callback_data: `reject:${card.pendingActionId}` },
            ]],
          },
        },
      )
    }
  } catch (err) {
    clearInterval(typingInterval)
    console.error('[telegram] agent call error:', err.message)
    await ctx.reply(`❌ সমস্যা হয়েছে: ${err.message}`)
  }
}

// ── Approve / Reject callback ──────────────────────────────────────────────

async function handleActionCallback(ctx, action, actionId) {
  const endpoint = action === 'approve' ? 'approve' : 'reject'
  try {
    const res = await fetch(`${APP_URL}/api/assistant/actions/${actionId}/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${INT_TOKEN}`,
      },
    })
    const data = await res.json()
    if (res.ok) {
      const label = action === 'approve' ? '✅ অনুমোদিত' : '❌ বাতিল করা হয়েছে'
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {})
      await ctx.answerCbQuery(label)
      await ctx.reply(label + (data.message ? `\n${data.message}` : ''))
    } else {
      await ctx.answerCbQuery(`সমস্যা: ${data.error ?? 'unknown'}`)
    }
  } catch (err) {
    await ctx.answerCbQuery(`Error: ${err.message}`)
  }
}

// ── /chats command ────────────────────────────────────────────────────────

async function showRecentChats(ctx) {
  try {
    const res = await fetch(`${APP_URL}/api/assistant/conversations?limit=5`, {
      headers: { Authorization: `Bearer ${INT_TOKEN}` },
    })
    if (!res.ok) { await ctx.reply('চ্যাট লোড করা যায়নি।'); return }
    const data = await res.json()
    const convs = Array.isArray(data) ? data : (data.conversations ?? [])
    if (convs.length === 0) { await ctx.reply('কোনো পুরানো চ্যাট নেই।'); return }

    const buttons = convs.map((c) => [{
      text: c.title || 'অনামা চ্যাট',
      callback_data: `switch:${c.id}`,
    }])
    await ctx.reply('সাম্প্রতিক চ্যাট:', {
      reply_markup: { inline_keyboard: buttons },
    })
  } catch (err) {
    await ctx.reply(`সমস্যা: ${err.message}`)
  }
}

// ── /staff link command ───────────────────────────────────────────────────

async function handleStaffLink(ctx, args) {
  // /staff link <name> <chatId>
  const parts = args.split(/\s+/)
  if (parts[0] !== 'link' || parts.length < 3) {
    await ctx.reply('ব্যবহার: /staff link <নাম> <chat_id>')
    return
  }
  const chatId = parts[parts.length - 1]
  const name   = parts.slice(1, parts.length - 1).join(' ')

  const res = await fetch(`${APP_URL}/api/assistant/internal/staff-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INT_TOKEN}` },
    body: JSON.stringify({ name, telegramChatId: chatId }),
  })
  const data = await res.json()
  if (res.ok) {
    await ctx.reply(`✅ ${name} — Telegram ID ${chatId} লিঙ্ক করা হয়েছে।`)
    // Send welcome message to the staff member
    try {
      await ctx.telegram.sendMessage(
        chatId,
        `আস্সালামু আলাইকুম ${name} ভাই! আপনাকে ALMA সিস্টেমে স্বাগতম। 🌙`,
      )
    } catch { /* staff may not have started the bot yet */ }
  } else {
    await ctx.reply(`❌ সমস্যা: ${data.error ?? 'unknown'}`)
  }
}

// ── Bot factory ────────────────────────────────────────────────────────────

export function createTelegramBot() {
  const token = process.env.ASSISTANT_BOT_TOKEN
  if (!token) throw new Error('ASSISTANT_BOT_TOKEN is not set')

  const bot = new Telegraf(token)

  // Unknown user guard
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id
    if (!chatId) return
    if (isOwner(chatId)) return next()

    // Unknown: reject politely and reveal their chat ID for Phase 6 onboarding
    await ctx.reply(
      `অনুমতি নেই।\n\nআপনার Chat ID: \`${chatId}\`\n\nStaff onboarding এর জন্য Owner-কে জানান।`,
      { parse_mode: 'Markdown' },
    )
    // Log unknown chat for staff collection
    console.log(`[telegram] unknown chat_id=${chatId} username=${ctx.from?.username ?? 'n/a'}`)
  })

  // ── Commands ─────────────────────────────────────────────────────────────

  bot.command('new', async (ctx) => {
    ownerState.conversationId = null
    await ctx.reply('✅ নতুন কথোপকথন শুরু হয়েছে।')
  })

  bot.command('chats', showRecentChats)

  bot.command('help', async (ctx) => {
    await ctx.reply(
      '*ALMA Assistant Bot*\n\n' +
      '• যেকোনো বার্তা পাঠান — আমি উত্তর দেব\n' +
      '• ভয়েস নোট পাঠাতে পারবেন\n' +
      '• ✅/❌ বোতাম দিয়ে অনুমোদন দিন\n\n' +
      '*কমান্ড:*\n' +
      '/new — নতুন চ্যাট শুরু\n' +
      '/chats — পুরানো চ্যাট দেখুন\n' +
      '/staff link <নাম> <chat_id> — স্টাফ লিঙ্ক করুন\n' +
      '/help — এই সাহায্য',
      { parse_mode: 'Markdown' },
    )
  })

  bot.command('staff', async (ctx) => {
    const args = ctx.message.text.replace(/^\/staff\s*/, '').trim()
    await handleStaffLink(ctx, args)
  })

  // ── Text messages ─────────────────────────────────────────────────────────

  bot.on('text', async (ctx) => {
    await handleOwnerText(ctx, ctx.message.text)
  })

  // ── Voice notes ───────────────────────────────────────────────────────────

  bot.on('voice', async (ctx) => {
    const fileId = ctx.message.voice.file_id
    try {
      await ctx.sendChatAction('typing')
      await ctx.reply('🎙️ ট্রান্সক্রাইব করছি...')
      const transcribed = await transcribeVoiceNote(bot, fileId)
      if (!transcribed.trim()) {
        await ctx.reply('কথা বুঝতে পারিনি। আবার চেষ্টা করুন।')
        return
      }
      await ctx.reply(`📝 _"${transcribed}"_`, { parse_mode: 'Markdown' })
      await handleOwnerText(ctx, transcribed)
    } catch (err) {
      console.error('[telegram] voice transcription error:', err.message)
      await ctx.reply(`❌ ভয়েস নোট প্রসেস করা যায়নি: ${err.message}`)
    }
  })

  // ── Callback queries (confirm cards + chats picker) ───────────────────────

  bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery.data ?? ''

    if (data.startsWith('approve:') || data.startsWith('reject:')) {
      const [action, actionId] = data.split(':')
      await handleActionCallback(ctx, action, actionId)
    } else if (data.startsWith('switch:')) {
      const convId = data.slice(7)
      ownerState.conversationId = convId
      await ctx.answerCbQuery('চ্যাট পরিবর্তন হয়েছে ✅')
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {})
      await ctx.reply('✅ চ্যাট পরিবর্তন হয়েছে।')
    } else {
      await ctx.answerCbQuery()
    }
  })

  // Register bot with notify module so Tier 1+ can use it
  setTelegramForNotify(bot, OWNER_ID)

  return bot
}
