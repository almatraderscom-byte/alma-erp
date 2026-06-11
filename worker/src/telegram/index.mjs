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
import { setDispatcherBot } from './dispatcher.mjs'
import { handleSalahCallback } from '../salah/scheduler.mjs'
import { handleReminderCallback } from '../reminders/callbacks.mjs'
import { handlePawnaCommand, handleDetailsCommand } from '../finance/index.mjs'
import {
  handleStaffLocation,
  handleLiveLocationStopped,
  promptTaskDoneLocation,
  resolveStaffByChatId,
  STAFF_ONBOARDING_BANGLA,
} from './location.mjs'
import {
  handleTodayCommand,
  handleKhorochCommand,
  handleAskCommand,
  sendAskCardTelegram,
} from './quick-commands.mjs'
import { captureWorkerError } from '../sentry.mjs'
import { safeLogMessage } from '../log-safe.mjs'

import { createClient } from '@supabase/supabase-js'

const APP_URL   = process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = process.env.AGENT_INTERNAL_TOKEN ?? ''
const OWNER_ID  = String(process.env.TELEGRAM_OWNER_CHAT_ID ?? '')

function createSupabase() {
  return createClient(
    process.env.SUPABASE_URL ?? '',
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  )
}

// Per-owner conversation state (in-memory — resets on worker restart, which is fine)
const ownerState = {
  conversationId: null, // null = auto-assign (daily conversation)
}

// Flood guard: max 12 messages/min per chat (owner Telegram)
const floodBuckets = new Map()
const FLOOD_LIMIT = Number(process.env.TELEGRAM_AGENT_FLOOD_PER_MIN ?? 12)

function checkFlood(chatId) {
  const now = Date.now()
  let bucket = floodBuckets.get(chatId)
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + 60_000 }
    floodBuckets.set(chatId, bucket)
  }
  bucket.count += 1
  return bucket.count <= FLOOD_LIMIT
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

/** Voice reply only when owner explicitly asks — not on every message. Reminders use notify({ voice: true }). */
function userWantsVoiceReply(text) {
  const t = String(text ?? '').toLowerCase()
  return (
    /\b(voice|audio|read aloud|শুনান|শুনতে|শোনাও|শুনিয়ে|কণ্ঠে|কথায় বল|ভয়েস)\b/i.test(t)
    || /শুনিয়ে দাও|voice note|বলে শোনাও|কথায় উত্তর/i.test(t)
  )
}

// ── Handle text message from owner ────────────────────────────────────────

async function autoMarkSalahFromText(text) {
  if (!text?.trim()) return
  try {
    await fetch(`${APP_URL}/api/assistant/internal/salah-auto-mark`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${INT_TOKEN}`,
      },
      body: JSON.stringify({ text }),
    })
  } catch (err) {
    console.warn('[telegram] salah-auto-mark failed:', err.message)
  }
}

async function handleOwnerText(ctx, text) {
  const chatId = ctx.chat?.id
  if (chatId && !checkFlood(chatId)) {
    await ctx.reply('অনেক দ্রুত মেসেজ পাঠানো হচ্ছে। এক মিনিট পরে আবার চেষ্টা করুন।')
    return
  }
  safeLogMessage('[telegram] owner message', `[len=${String(text ?? '').length}]`)

  // Persist prayer confirmations immediately (before agent turn / scheduler race)
  await autoMarkSalahFromText(text)

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

    // Voice only when owner explicitly requests it (reminders send voice via notify())
    if (process.env.GOOGLE_TTS_CREDENTIALS && userWantsVoiceReply(text)) {
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

    // ask_user clarifying cards
    for (const ask of result.askCards ?? []) {
      await sendAskCardTelegram(ctx, ask)
    }
  } catch (err) {
    clearInterval(typingInterval)
    captureWorkerError(err, 'worker.telegram.agent_call')
    safeLogMessage('[telegram] agent call error:', err.message)
    const bangla = /rate_limited|429/i.test(err.message)
      ? 'অনেক দ্রুত মেসেজ পাঠানো হচ্ছে। এক মিনিট পরে আবার চেষ্টা করুন।'
      : /quota|credit|billing/i.test(err.message)
        ? 'API কোটা শেষ — মালিককে জানানো হয়েছে।'
        : `সমস্যা হয়েছে। আবার চেষ্টা করুন।`
    await ctx.reply(`❌ ${bangla}`)
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

  // Access guard: owner + linked staff (callback_query only for staff — no text access)
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id
    if (!chatId) return
    if (isOwner(chatId)) return next()

    const cbData = ctx.callbackQuery?.data ?? ''

    // Linked staff: task Done, location skip, ask_pick (staff should not get ask_pick — owner only)
    if (cbData.startsWith('task_done:') || cbData.startsWith('loc_skip:')) {
      const supabase = createSupabase()
      const staff = await resolveStaffByChatId(supabase, chatId)
      if (staff) return next()
    }

    // Staff location messages (not owner)
    if (ctx.message?.location && !isOwner(chatId)) {
      const supabase = createSupabase()
      const staff = await resolveStaffByChatId(supabase, chatId)
      if (staff) return next()
    }

    // Unknown: reject politely and reveal their chat ID for onboarding
    await ctx.reply(
      `অনুমতি নেই।\n\nআপনার Chat ID: \`${chatId}\`\n\nStaff onboarding এর জন্য Owner-কে জানান।`,
      { parse_mode: 'Markdown' },
    )
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
      '• ভয়েস নোট পাঠাতে পারবেন (উত্তর শুনতে চাইলে "শুনান" বলুন)\n' +
      '• ✅/❌ বোতাম দিয়ে অনুমোদন দিন\n\n' +
      '*কমান্ড:*\n' +
      '/new — নতুন চ্যাট শুরু\n' +
      '/chats — পুরানো চ্যাট দেখুন\n' +
      '/staff link <নাম> <chat_id> — স্টাফ লিঙ্ক করুন\n' +
      '/today — আজকের স্ন্যাপশট\n' +
      '/khoroch — খরচ সারাংশ\n' +
      '/ask <প্রশ্ন> — agent-কে জিজ্ঞেস করুন\n' +
      '/staff_onboard — স্টাফ GPS অনবোর্ডিং মেসেজ\n' +
      '/help — এই সাহায্য',
      { parse_mode: 'Markdown' },
    )
  })

  bot.command('staff', async (ctx) => {
    const args = ctx.message.text.replace(/^\/staff\s*/, '').trim()
    await handleStaffLink(ctx, args)
  })

  // ── Phase 6 finance commands ──────────────────────────────────────────────

  bot.command('pawna', async (ctx) => {
    if (!isOwner(ctx.chat?.id)) return
    const supabase = createSupabase()
    await handlePawnaCommand(ctx, supabase)
  })

  bot.command('details', async (ctx) => {
    if (!isOwner(ctx.chat?.id)) return
    const args = ctx.message.text.replace(/^\/details\s*/, '').trim()
    if (!args) { await ctx.reply('ব্যবহার: /details <নাম>'); return }
    const supabase = createSupabase()
    await handleDetailsCommand(ctx, args, supabase)
  })

  bot.command('today', async (ctx) => {
    if (!isOwner(ctx.chat?.id)) return
    const supabase = createSupabase()
    await handleTodayCommand(ctx, supabase)
  })

  bot.command('khoroch', async (ctx) => {
    if (!isOwner(ctx.chat?.id)) return
    const supabase = createSupabase()
    await handleKhorochCommand(ctx, supabase)
  })

  bot.command('ask', async (ctx) => {
    if (!isOwner(ctx.chat?.id)) return
    await handleAskCommand(ctx, ctx.message.text, sendToAgent, ownerState)
  })

  bot.command('staff_onboard', async (ctx) => {
    if (!isOwner(ctx.chat?.id)) return
    await ctx.reply(STAFF_ONBOARDING_BANGLA, { parse_mode: 'Markdown' })
  })

  // ── Text messages ─────────────────────────────────────────────────────────

  bot.on('text', async (ctx) => {
    const chatId = ctx.chat?.id
    if (!isOwner(chatId)) {
      const supabase = createSupabase()
      const staff = await resolveStaffByChatId(supabase, chatId)
      if (staff && ctx.message.text === 'লোকেশন skip') {
        await ctx.reply('ঠিক আছে — লোকেশন ছাড়াই চলবে।')
        return
      }
      return
    }
    await handleOwnerText(ctx, ctx.message.text)
  })

  // ── Staff location (live + one-time) ─────────────────────────────────────

  bot.on('location', async (ctx) => {
    const chatId = ctx.chat?.id
    if (isOwner(chatId)) return
    const supabase = createSupabase()
    const staff = await resolveStaffByChatId(supabase, chatId)
    if (!staff) return
    await handleStaffLocation(ctx, supabase, ctx.message.location, 'live')
  })

  bot.on('edited_message', async (ctx) => {
    const em = ctx.editedMessage
    if (!em?.location) return
    const chatId = ctx.chat?.id
    if (isOwner(chatId)) return
    const supabase = createSupabase()
    const staff = await resolveStaffByChatId(supabase, chatId)
    if (!staff) return
    const loc = em.location
    if (loc.live_period === 0) {
      await handleLiveLocationStopped(ctx, supabase, staff.name)
    } else {
      await handleStaffLocation(ctx, supabase, loc, 'live')
    }
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

    } else if (data.startsWith('salah_done:') || data.startsWith('salah_later:')) {
      // salah_done:<waqt>:<status> or salah_later:<waqt>
      const parts  = data.split(':')
      const action = parts[0]
      const waqt   = parts[1]
      const status = parts[2]
      await handleSalahCallback(ctx, action, waqt, status)

    } else if (data.startsWith('reminder_done:') || data.startsWith('reminder_snooze:') || data.startsWith('reminder_cancel:')) {
      await handleReminderCallback(ctx, data)

    } else if (data.startsWith('task_done:')) {
      const [, taskId, staffId] = data.split(':')
      try {
        const res = await fetch(`${APP_URL}/api/assistant/internal/task-callback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INT_TOKEN}` },
          body: JSON.stringify({ taskId, staffId, action: 'done' }),
        })
        const result = await res.json()
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {})
        await ctx.answerCbQuery('✅ Done!')
        await ctx.reply('✅ কাজ সম্পন্ন হিসেবে চিহ্নিত হয়েছে। জাযাকাল্লাহ খাইর!')

        if (OWNER_ID && result.staffName) {
          await ctx.telegram.sendMessage(
            OWNER_ID,
            `✅ *${result.staffName}* একটি কাজ সম্পন্ন করেছে।`,
            { parse_mode: 'Markdown' },
          ).catch(() => {})
        }

        await promptTaskDoneLocation(ctx, staffId, result.staffName)
      } catch (err) {
        await ctx.answerCbQuery('সমস্যা হয়েছে')
        console.error('[telegram] task_done callback error:', err.message)
      }

    } else if (data.startsWith('ask_pick:')) {
      if (!isOwner(ctx.chat?.id)) {
        await ctx.answerCbQuery('অনুমতি নেই')
        return
      }
      const [, askCardId, optIdxStr] = data.split(':')
      const optIdx = parseInt(optIdxStr, 10)
      try {
        const cardRes = await fetch(`${APP_URL}/api/assistant/internal/ask-card?id=${askCardId}`, {
          headers: { Authorization: `Bearer ${INT_TOKEN}` },
        })
        const card = await cardRes.json()
        const options = JSON.parse(card.options ?? '[]')
        const option = options[optIdx]
        if (!option) {
          await ctx.answerCbQuery('অপশন পাওয়া যায়নি')
          return
        }
        await fetch(`${APP_URL}/api/assistant/ask-cards/${askCardId}/answer`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${INT_TOKEN}`,
          },
          body: JSON.stringify({ option }),
        })
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {})
        await ctx.answerCbQuery(`✅ ${option}`)
        await handleOwnerText(ctx, option)
      } catch (err) {
        await ctx.answerCbQuery(`সমস্যা: ${err.message}`)
      }

    } else if (data.startsWith('loc_skip:')) {
      await ctx.answerCbQuery('লোকেশন skip')
      await ctx.reply('ঠিক আছে — লোকেশন ছাড়াই চলবে।')

    } else if (data.startsWith('details:')) {
      // details:<name>:<page>  — owner's paginated finance details
      if (isOwner(ctx.chat?.id)) {
        const [, name, pageStr] = data.split(':')
        const supabase = createSupabase()
        await ctx.answerCbQuery()
        await handleDetailsCommand(ctx, name, supabase, parseInt(pageStr || '0', 10))
      }

    } else if (data.startsWith('msg_draft:') || data.startsWith('staff_feedback:')) {
      // Messenger alert callbacks — owner-only
      if (isOwner(ctx.chat?.id)) {
        const [action, convId, pageId] = data.split(':')
        await ctx.answerCbQuery()
        if (action === 'msg_draft') {
          await ctx.reply(
            'নতুন draft চাইছেন — agent-কে জিজ্ঞেস করুন: "Conversation ' + convId + '-এর জন্য draft দাও"',
          )
        } else {
          await ctx.reply(
            'স্টাফকে feedback পাঠানোর জন্য বলুন: "এই কনভার্সেশনে staff-কে feedback দাও"',
          )
        }
      }

    } else {
      await ctx.answerCbQuery()
    }
  })

  // Register bot with notify module so Tier 1+ can use it
  setTelegramForNotify(bot, OWNER_ID)

  return bot
}
