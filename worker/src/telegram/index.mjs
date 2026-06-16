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
import { transcribeVoiceNote } from './voice.mjs'
import { setTelegramForNotify } from '../notify/index.mjs'
import { setDispatcherBot, getDispatcherBot } from './dispatcher.mjs'
import { handleSalahCallback } from '../salah/scheduler.mjs'
import { handleReminderCallback } from '../reminders/callbacks.mjs'
import { handlePawnaCommand, handleDetailsCommand } from '../finance/index.mjs'
import {
  handleStaffLocation,
  handleLiveLocationStopped,
  resolveStaffByChatId,
  broadcastStaffOnboard,
} from './location.mjs'
import {
  handleTodayCommand,
  handleKhorochCommand,
  handleAskCommand,
  sendAskCardTelegram,
} from './quick-commands.mjs'
import {
  handleCatalogPhotoMessage,
  handleCatalogStatus,
  handleCatalogSuggest,
  handleGroupCommand,
  handleSizeChartCommand,
  handleCatalogCallback,
  showCatalogGuide,
} from './catalog.mjs'
import { captureWorkerError } from '../sentry.mjs'
import { safeLogMessage } from '../log-safe.mjs'
import { replyMarkdownSafe } from './markdown-safe.mjs'
import { parseTaskIdFromCallback } from './callback-data.mjs'
import { registerBotCommands } from './commands.mjs'
import { buildOwnerHelpText, buildStaffHelpText } from './help.mjs'
import { showMenuPanel, handleMenuCallback, showContentEngineStatus } from './menu.mjs'
import {
  showCsPanel,
  showDetailsPicker,
  handleDetailsPick,
  showAskPrompt,
  getAskExample,
  showPostlinkGuide,
  showStaffGuide,
  showGroupPanel,
  showGroupHelp,
  handleGroupSuggestCallback,
  showCatalogPanel,
} from './command-defaults.mjs'
import { ownerState, isOwnerTurnInFlight, markOwnerTurnStart, releaseOwnerTurn } from './owner-state.mjs'
import { callAgentApi as sendToAgent } from './agent-turn.mjs'

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

// Per-owner conversation state lives in owner-state.mjs (shared with background agent-turn worker)

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

async function getDailyConversationId(personalMode = false) {
  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const title = personalMode ? `Telegram ব্যক্তিগত ${today}` : `Telegram ${today}`

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

// ── Voice reply detection ─────────────────────────────────────────────────

/**
 * Voice reply to owner only when they want the AGENT to speak in voice — not when they ask
 * to send voice to staff/someone else. Reminders use notify({ voice: true }).
 */
function userWantsVoiceReply(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return false

  const hasVoiceKeyword =
    /\b(voice|audio|read aloud|voice note|shuniye|shunao)\b/i.test(raw)
    || /শুনান|শুনতে|শোনাও|শুনিয়ে|কণ্ঠে|কথায় বল|ভয়েস/i.test(raw)

  if (!hasVoiceKeyword) return false

  // "take/staff ke voice dao" — outbound to staff, not a voice reply to owner
  const outboundVoice =
    /(?:স্টাফ|staff|তাকে|take|কাউকে|কারো|জনকে|কর্মচারী|কর্মী|মুস্তাহিদ|mustahid|ইয়াফি|eyafi|employee).{0,50}(?:voice|ভয়েস|শুনান|শুনিয়ে|audio)/iu.test(raw)
    || /(?:voice|ভয়েস|শুনান|শুনিয়ে|audio).{0,50}(?:স্টাফ|staff|তাকে|take|কাউকে|কারো|জনকে|পাঠাও|জানাও|দাও|দিতে|message|মেসেজ|বার্তা)/iu.test(raw)
    || /(?:message|মেসেজ|বার্তা|নোটিস).{0,40}(?:voice|ভয়েস|শুনান)/iu.test(raw)
    || /(?:voice|ভয়েস).{0,30}(?:ও\s*)?(?:take|তাকে|জেনো|যেনো).{0,15}(?:দে|দাও|দিতে|পাঠ)/iu.test(raw)
    || /(?:voice|ভয়েস|শুনিয়ে).{0,20}(?:ও\s*)(?:take|তাকে)/iu.test(raw)

  if (outboundVoice) return false

  return (
    /\b(voice|audio|read aloud|voice note|shuniye|shunao)\b/i.test(raw)
    || /শুনিয়ে দাও|বলে শোনাও|কথায় উত্তর|শুনান|শুনতে|শোনাও|কণ্ঠে|কথায় বল/i.test(raw)
    || /(?:আমাকে|amake|amk|amke).{0,25}(?:voice|ভয়েস|শুনান|শোনাও)/iu.test(raw)
    || /(?:voice|ভয়েস).{0,25}(?:এ|e)?\s*(?:বল|bolo|উত্তর|reply|জবাব)/iu.test(raw)
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

  if (ownerState.financeEdit) {
    const { handleFinanceEditValue } = await import('../finance/confirm-cards.mjs')
    const handled = await handleFinanceEditValue(ctx, APP_URL, INT_TOKEN, ownerState, text)
    if (handled) return
  }

  const { awaitingRedoNote, applyOwnerRedoNote } = await import('../staff/task-verification.mjs')
  const redoTaskId = awaitingRedoNote.get(String(chatId))
  if (redoTaskId) {
    awaitingRedoNote.delete(String(chatId))
    const supabase = createSupabase()
    const note = String(text ?? '').trim().toLowerCase() === 'skip' ? '' : String(text ?? '').trim()
    await applyOwnerRedoNote(ctx, supabase, redoTaskId, note)
    await ctx.reply('🔄 স্টাফকে পুনরায় করতে বলা হয়েছে।')
    return
  }

  if (chatId && !checkFlood(chatId)) {
    await ctx.reply('অনেক দ্রুত মেসেজ পাঠানো হচ্ছে। এক মিনিট পরে আবার চেষ্টা করুন।')
    return
  }
  safeLogMessage('[telegram] owner message', `[len=${String(text ?? '').length}]`)

  const supabase = createSupabase()
  const { isPersonalSnoozeMessage, setPersonalSnoozeToday } = await import('../personal/snooze.mjs')
  if (isPersonalSnoozeMessage(text)) {
    await setPersonalSnoozeToday(supabase).catch((err) => {
      console.warn('[telegram] personal snooze set failed:', err.message)
    })
  }

  // Persist prayer confirmations immediately (before agent turn / scheduler race)
  await autoMarkSalahFromText(text)

  // Use current conversation or get/create daily one
  const { getTelegramPersonalMode } = await import('./personal-mode.mjs')
  const personalMode = await getTelegramPersonalMode(supabase, String(chatId))

  let convId = personalMode ? ownerState.personalConversationId : ownerState.conversationId
  // Per-conversation tracking: let chat route create a new conversation when none active

  await ctx.reply('⏳ ভাবছি স্যার...')
  const { enqueueAgentTurn } = await import('./agent-turn.mjs')
  await enqueueAgentTurn({
    chatId: String(chatId),
    text,
    conversationId: convId,
    personalMode,
    wantsVoice: userWantsVoiceReply(text),
  })
  return { queued: true }
}

/** One owner turn at a time per chat — returns immediately; agent runs in background queue. */
function dispatchOwnerText(ctx, text) {
  const chatId = String(ctx.chat?.id ?? '')
  if (!chatId) return
  if (isOwnerTurnInFlight(chatId)) {
    void ctx.reply('⏳ আগের মেসেজের উত্তর এখনো প্রস্তুত হচ্ছে — একটু অপেক্ষা করুন।').catch(() => {})
    return
  }
  markOwnerTurnStart(chatId)
  void handleOwnerText(ctx, text)
    .then((r) => {
      if (!r?.queued) releaseOwnerTurn(chatId)
    })
    .catch((err) => {
      console.error('[telegram] owner turn failed:', err.message)
      captureWorkerError(err, 'worker.telegram.owner_turn')
      void ctx.reply('❌ সমস্যা হয়েছে। /new দিয়ে নতুন চ্যাট শুরু করে আবার চেষ্টা করুন।').catch(() => {})
      releaseOwnerTurn(chatId)
    })
}

// ── Confirm card keyboards (inline callbacks still use this) ─────────────

async function buildConfirmCardKeyboard(card) {
  const { buildFinanceKeyboard } = await import('../finance/confirm-cards.mjs')
  if (card.isFinance) return buildFinanceKeyboard(card)

  const supabase = createSupabase()
  const { data: pendingAction } = await supabase
    .from('agent_pending_actions')
    .select('type, payload')
    .eq('id', card.pendingActionId)
    .maybeSingle()

  if (pendingAction?.type === 'dispatch_staff_tasks') {
    const date = pendingAction.payload?.date ?? ''
    return [
      [
        { text: '✅ অনুমোদন', callback_data: `approve:${card.pendingActionId}` },
        { text: '✏️ Edit', callback_data: `proposal_edit:${date}` },
      ],
      [
        { text: '➕ Add Task', callback_data: `proposal_addtask:${date}` },
        { text: '❌ বাতিল', callback_data: `reject:${card.pendingActionId}` },
      ],
    ]
  }

  if (pendingAction?.type === 'content_gate1' && pendingAction.payload?.stage === 'gate1_ready') {
    const { buildContentGate1KeyboardFromPayload } = await import('../approvals/resend-card.mjs')
    return buildContentGate1KeyboardFromPayload(card.pendingActionId, pendingAction.payload).inline_keyboard
  }

  return [[
    { text: '✅ অনুমোদন', callback_data: `approve:${card.pendingActionId}` },
    { text: '❌ বাতিল', callback_data: `reject:${card.pendingActionId}` },
  ]]
}

// ── Approve / Reject callback ──────────────────────────────────────────────

async function findPendingProposalAction(supabase, dateYmd) {
  const { data: rows } = await supabase
    .from('agent_pending_actions')
    .select('id, payload, summary, status')
    .eq('type', 'dispatch_staff_tasks')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
  return (rows ?? []).find((r) => r.payload?.date === dateYmd) ?? null
}

async function dispatchApprovedStaffTasks(ctx, actionId) {
  const supabase = createSupabase()
  const { data: pendingAction } = await supabase
    .from('agent_pending_actions')
    .select('type, payload')
    .eq('id', actionId)
    .maybeSingle()

  if (pendingAction?.type !== 'dispatch_staff_tasks') return null

  const { date, taskIds } = pendingAction.payload ?? {}
  const bot = getDispatcherBot()
  if (!bot || !date) return null

  const { dispatchTasksToStaff, formatDispatchOwnerReport } = await import('../staff/dispatch.mjs')
  const dispatchResult = await dispatchTasksToStaff({ supabase, bot, date, taskIds })
  return formatDispatchOwnerReport(dispatchResult)
}

async function handleActionCallback(ctx, action, actionId) {
  const endpoint = action === 'approve' ? 'approve' : 'reject'
  try {
    await ctx.answerCbQuery('⏳ প্রক্রিয়া চলছে…')
    await ctx.sendChatAction('typing').catch(() => {})

    // Pre-check dispatch_staff_tasks — skip if already resolved or tasks already sent
    if (action === 'approve') {
      const supabase = createSupabase()
      const { data: pendingAction } = await supabase
        .from('agent_pending_actions')
        .select('type, payload, status')
        .eq('id', actionId)
        .maybeSingle()
      if (pendingAction?.type === 'dispatch_staff_tasks') {
        if (pendingAction.status !== 'pending') {
          await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {})
          return
        }
        if (pendingAction.payload?.date) {
          const { count: proposedCount } = await supabase
            .from('staff_tasks')
            .select('id', { count: 'exact', head: true })
            .eq('proposed_for', pendingAction.payload.date)
            .eq('status', 'proposed')
          if ((proposedCount ?? 0) === 0) {
            const { count: sentCount } = await supabase
              .from('staff_tasks')
              .select('id', { count: 'exact', head: true })
              .eq('proposed_for', pendingAction.payload.date)
              .in('status', ['sent', 'done'])
            await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {})
            if ((sentCount ?? 0) > 0) {
              await supabase
                .from('agent_pending_actions')
                .update({ status: 'executed', resolvedAt: new Date().toISOString() })
                .eq('id', actionId)
              await ctx.reply('ℹ️ ইতোমধ্যে পাঠানো হয়েছে — নতুন টাস্ক যোগ করতে agent-কে বলুন।')
            }
            return
          }
        }
      }
    }

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
      if (action === 'approve') {
        const dispatchReport = await dispatchApprovedStaffTasks(ctx, actionId)
        if (dispatchReport) {
          await ctx.reply(`${label}\n${dispatchReport}`)
        } else {
          await ctx.reply(label + (data.message ? `\n${data.message}` : ''))
        }
      } else {
        await ctx.reply(label + (data.message ? `\n${data.message}` : ''))
      }
    } else if (data.error === 'already_resolved') {
      const statusLabel = data.status === 'executed' ? '✅ ইতিমধ্যে সম্পন্ন হয়েছে' :
                          data.status === 'approved' ? '✅ ইতিমধ্যে অনুমোদিত' :
                          data.status === 'rejected' ? '❌ ইতিমধ্যে বাতিল' :
                          `ℹ️ স্ট্যাটাস: ${data.status ?? 'unknown'}`
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {})
      await ctx.reply(statusLabel)
    } else if (data.error === 'expired') {
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {})
      await ctx.reply('⏰ এই কার্ডটির মেয়াদ শেষ হয়ে গেছে। নতুন করে অনুরোধ করুন।')
    } else {
      await ctx.reply(`❌ সমস্যা: ${data.error ?? 'unknown'}`)
    }
  } catch (err) {
    await ctx.answerCbQuery(`Error: ${err.message}`)
  }
}

// ── CS-1 customer sales controls (owner only) ─────────────────────────────

async function handleCsModeCommand(ctx, modeArg) {
  const modes = { off: 'off', shadow: 'shadow', night: 'auto_night', auto: 'auto' }
  const mode = modes[modeArg?.toLowerCase()]
  if (!mode) {
    await ctx.reply('ব্যবহার: /cs off|shadow|night|auto|status|resume <conversationId>')
    return
  }
  await fetch(`${APP_URL}/api/assistant/internal/agent-settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INT_TOKEN}` },
    body: JSON.stringify({ key: 'cs_mode', value: mode }),
  })
  await ctx.reply(`✅ CS mode → *${mode}*`, { parse_mode: 'Markdown' })
}

async function handleCsStatus(ctx) {
  const res = await fetch(`${APP_URL}/api/assistant/internal/agent-settings?keys=cs_mode`, {
    headers: { Authorization: `Bearer ${INT_TOKEN}` },
  })
  const data = await res.json()
  await ctx.reply(`📊 CS mode: *${data.cs_mode ?? 'off'}*`, { parse_mode: 'Markdown' })
}

async function handleCsResume(ctx, convId) {
  if (!convId) {
    await ctx.reply('ব্যবহার: /cs resume <conversationId>')
    return
  }
  const res = await fetch(`${APP_URL}/api/assistant/internal/cs-resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INT_TOKEN}` },
    body: JSON.stringify({ conversationId: convId }),
  })
  const data = await res.json()
  if (!res.ok) {
    await ctx.reply(`❌ ${data.error ?? 'resume failed'}`)
    return
  }
  await ctx.reply(`✅ CS resumed for ${convId}`)
}

async function handleCsFollowups(ctx, on) {
  const res = await fetch(`${APP_URL}/api/assistant/internal/cs-followups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INT_TOKEN}` },
    body: JSON.stringify({ action: 'set_enabled', enabled: on }),
  })
  if (!res.ok) {
    await ctx.reply('❌ followups setting failed')
    return
  }
  await ctx.reply(`✅ CS follow-ups → *${on ? 'on' : 'off'}*`, { parse_mode: 'Markdown' })
}

async function handleCsBlock(ctx, psid) {
  if (!psid) {
    await ctx.reply('ব্যবহার: /cs block <psid>')
    return
  }
  const pageId = process.env.CS_DEFAULT_PAGE_ID ?? '1044848232034171'
  const res = await fetch(`${APP_URL}/api/assistant/internal/cs-block`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INT_TOKEN}` },
    body: JSON.stringify({ pageId, psid, blockedBy: String(ctx.chat?.id) }),
  })
  const data = await res.json()
  if (!res.ok) {
    await ctx.reply(`❌ ${data.error ?? 'block failed'}`)
    return
  }
  await ctx.reply(`✅ Blocked ${psid}`)
}

async function handlePostlink(ctx, args) {
  if (args.length < 2) {
    await ctx.reply('ব্যবহার: /postlink <fb post url or id> CODE1 CODE2')
    return
  }
  const postRef = args[0]
  const codes = args.slice(1)
  const res = await fetch(`${APP_URL}/api/assistant/internal/cs-postlink`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INT_TOKEN}` },
    body: JSON.stringify({ postRef, productCodes: codes }),
  })
  const data = await res.json()
  if (!res.ok) {
    await ctx.reply(`❌ ${data.error ?? 'postlink failed'}`)
    return
  }
  await ctx.reply(`✅ Post linked: ${data.postId}\nCodes: ${(data.codes ?? []).join(', ')}`)
}

async function handleCsConfirmOrder(ctx, draftId) {
  await ctx.answerCbQuery('⏳ কনফার্ম হচ্ছে…')
  const res = await fetch(`${APP_URL}/api/assistant/internal/cs-confirm-order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INT_TOKEN}` },
    body: JSON.stringify({ draftId, confirmedBy: String(ctx.chat?.id) }),
  })
  const data = await res.json()
  if (!res.ok) {
    await ctx.reply(`❌ ${data.error ?? 'confirm failed'}`)
    return
  }
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {})
  await ctx.reply('✅ অর্ডার কনফার্ম — কাস্টমারকে মেসেজ পাঠানো হয়েছে')
}

async function handleCsSendDraft(ctx, draftId) {
  await ctx.answerCbQuery('⏳ পাঠানো হচ্ছে…')
  try {
    const res = await fetch(`${APP_URL}/api/assistant/internal/cs-shadow-draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INT_TOKEN}` },
      body: JSON.stringify({ draftId, action: 'send', sentBy: String(ctx.chat?.id) }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      const errMsg = data.message || data.error || `HTTP ${res.status}`
      await ctx.reply(`❌ পাঠানো যায়নি: ${errMsg}`)
      return
    }
    const { sendMessengerText, sendMessengerImage } = await import('../cs/meta-send.mjs')
    const attachments = Array.isArray(data.attachments) ? data.attachments : []
    try {
      await sendMessengerText(data.pageId, data.psid, data.draftText)
      for (const att of attachments) {
        if (att?.imageUrl) await sendMessengerImage(data.pageId, data.psid, att.imageUrl)
      }
    } catch (sendErr) {
      await ctx.reply(`❌ Facebook পাঠাতে ব্যর্থ (page ${data.pageId}): ${sendErr.message?.slice(0, 200)}`)
      return
    }
    const markRes = await fetch(`${APP_URL}/api/assistant/internal/cs-shadow-draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INT_TOKEN}` },
      body: JSON.stringify({ draftId, action: 'mark_sent', sentBy: String(ctx.chat?.id) }),
    })
    if (!markRes.ok) {
      const markData = await markRes.json().catch(() => ({}))
      await ctx.reply(`⚠️ পাঠানো হয়েছে কিন্তু স্ট্যাটাস আপডেট ব্যর্থ: ${markData.error ?? markRes.status}`)
      return
    }
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {})
    await ctx.reply('✅ কাস্টমারকে পাঠানো হয়েছে')
  } catch (err) {
    await ctx.reply(`❌ সমস্যা: ${err.message}`)
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
        `আস্সালামু আলাইকুম ${name} ভাই! আপনাকে ALMA সিস্টেমে স্বাগতম। 🌙\n\n` +
          `এখানে শুধু দৈনিক *কাজের টাস্ক* আসবে — ✅ Done চাপবেন।\n` +
          `অফিসে কাজের সময় *Live Location* শেয়ার করা বাধ্যতামূলক।\n` +
          `সাধারণ মেসেজের উত্তর দেওয়া হয় না; /start চাপলে গাইড দেখবেন।`,
        { parse_mode: 'Markdown' },
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

  const apiRoot = (process.env.TELEGRAM_API_BASE ?? '').replace(/\/$/, '') || 'https://api.telegram.org'
  const bot = new Telegraf(token, { telegram: { apiRoot } })

  bot.use(async (ctx, next) => {
    try {
      await next()
    } catch (err) {
      console.error('[telegram] handler error:', err.message)
      captureWorkerError('telegram.handler', err)
      try {
        await ctx.reply?.('❌ সমস্যা হয়েছে। আবার চাপুন।')
      } catch { /* ignore secondary failure */ }
    }
  })

  // Access guard: owner full access; linked staff = tasks + location only (not AI agent).
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id
    if (!chatId) return
    if (isOwner(chatId)) return next()

    const supabase = createSupabase()
    const staff = await resolveStaffByChatId(supabase, chatId)

    if (staff) {
      const cbData = ctx.callbackQuery?.data ?? ''
      const ownerOnlyCb =
        cbData.startsWith('approve:')
        || cbData.startsWith('reject:')
        || cbData.startsWith('salah_')
        || cbData.startsWith('reminder_')
        || cbData.startsWith('ask_pick:')
        || cbData.startsWith('task_vfy_ok:')
        || cbData.startsWith('task_vfy_redo:')
        || cbData.startsWith('switch:')
        || cbData.startsWith('cat_del_')
        || cbData.startsWith('csg_')
        || cbData.startsWith('menu:')
        || cbData.startsWith('details_pick:')
        || cbData.startsWith('ask_go:')
        || cbData === 'group:suggest'
        || cbData === 'catalog:suggest'
      if (ownerOnlyCb) {
        await ctx.answerCbQuery?.('এই বাটন শুধু Owner-এর জন্য')
        return
      }
      return next()
    }

    // Not linked — reject and show chat ID for /staff link
    await ctx.reply(
      `অনুমতি নেই।\n\nআপনার Chat ID: \`${chatId}\`\n\nStaff onboarding এর জন্য Owner-কে জানান।`,
      { parse_mode: 'Markdown' },
    )
    console.log(`[telegram] unknown chat_id=${chatId} username=${ctx.from?.username ?? 'n/a'}`)
  })

  // ── Commands ─────────────────────────────────────────────────────────────

  bot.command('new', async (ctx) => {
    ownerState.conversationId = null
    ownerState.personalConversationId = null
    await ctx.reply('✅ নতুন কথোপকথন শুরু হয়েছে।')
  })

  bot.command('personal', async (ctx) => {
    if (!isOwner(ctx.chat?.id)) {
      await ctx.reply('শুধু Owner')
      return
    }
    const supabase = createSupabase()
    const { setTelegramPersonalMode } = await import('./personal-mode.mjs')
    await setTelegramPersonalMode(supabase, String(ctx.chat.id), true)
    ownerState.personalConversationId = null
    await ctx.reply(
      '🤲 ব্যক্তিগত মোড চালু। শুধু আপনার ব্যক্তিগত/পারিবারিক বিষয়ে কথা হবে। বের হতে /work লিখুন।',
    )
  })

  bot.command('work', async (ctx) => {
    if (!isOwner(ctx.chat?.id)) {
      await ctx.reply('শুধু Owner')
      return
    }
    const supabase = createSupabase()
    const { setTelegramPersonalMode } = await import('./personal-mode.mjs')
    await setTelegramPersonalMode(supabase, String(ctx.chat.id), false)
    ownerState.conversationId = null
    await ctx.reply('কাজের মোডে ফিরে এলাম।')
  })

  bot.command('chats', showRecentChats)

  bot.start(async (ctx) => {
    const chatId = ctx.chat?.id
    if (isOwner(chatId)) {
      await ctx.reply('আস্সালামু আলাইকুম Sir! যেকোনো বার্তা পাঠান — আমি সাহায্য করব।')
      return
    }
    const supabase = createSupabase()
    const staff = await resolveStaffByChatId(supabase, chatId)
    if (staff) {
      await ctx.reply(
        `আস্সালামু আলাইকুম ${staff.name} ভাই! 🌙\n\n` +
          `আপনি ALMA স্টাফ হিসেবে লিঙ্ক আছেন।\n` +
          `• দৈনিক কাজের টাস্ক এখানে আসবে — ✅ *Done* চাপুন\n` +
          `• কাজ Done-এর পর লোকেশন শেয়ার *বাধ্যতামূলক* (৩ মিনিটের মধ্যে)\n` +
          `• সাধারণ চ্যাটের উত্তর এই বট দেয় না`,
        { parse_mode: 'Markdown' },
      )
      return
    }
    await ctx.reply(
      `অনুমতি নেই।\n\nআপনার Chat ID: \`${chatId}\`\n\nOwner-কে বলুন লিঙ্ক করতে: /staff link <নাম> ${chatId}`,
      { parse_mode: 'Markdown' },
    )
  })

  bot.command('menu', async (ctx) => {
    if (!isOwner(ctx.chat?.id)) {
      await ctx.reply('শুধু Owner')
      return
    }
    await showMenuPanel(ctx)
  })

  bot.command('help', async (ctx) => {
    const text = isOwner(ctx.chat?.id) ? buildOwnerHelpText() : buildStaffHelpText()
    await replyMarkdownSafe(ctx, text)
  })

  bot.command('staff', async (ctx) => {
    if (!isOwner(ctx.chat?.id)) {
      await ctx.reply('শুধু Owner')
      return
    }
    const args = ctx.message.text.replace(/^\/staff\s*/, '').trim()
    const supabase = createSupabase()
    if (!args) {
      await showStaffGuide(ctx, supabase)
      return
    }
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
    const supabase = createSupabase()
    if (!args) {
      await showDetailsPicker(ctx, supabase)
      return
    }
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
    const query = ctx.message.text.replace(/^\/ask\s*/i, '').trim()
    if (!query) {
      await showAskPrompt(ctx)
      return
    }
    await handleAskCommand(ctx, ctx.message.text, sendToAgent, ownerState)
  })

  bot.command('staff_onboard', async (ctx) => {
    if (!isOwner(ctx.chat?.id)) return
    const supabase = createSupabase()
    try {
      const { sent, failed, total, onboarded } = await broadcastStaffOnboard(ctx.telegram, supabase)
      let msg = `✅ GPS অনবোর্ডিং গাইড ${sent}/${total} জন স্টাফকে পাঠানো হয়েছে।`
      if (onboarded?.length) {
        msg += `\n⏱️ ৩ মিনিটের মধ্যে লোকেশন না পাঠালে আপনাকে জানানো হবে: ${onboarded.join(', ')}`
      }
      if (failed.length) msg += `\n⚠️ ব্যর্থ: ${failed.join(', ')}`
      await ctx.reply(msg)
    } catch (err) {
      await ctx.reply(`❌ পাঠানো যায়নি: ${err.message}`)
    }
  })

  // ── CS-0 catalog commands ─────────────────────────────────────────────────

  bot.command('catalog', async (ctx) => {
    const args = ctx.message.text.replace(/^\/catalog\s*/, '').trim()
    const owner = isOwner(ctx.chat?.id)
    if (args === 'suggest') {
      if (!owner) {
        await ctx.reply('❌ শুধু Owner।')
        return
      }
      await handleCatalogSuggest(ctx)
      return
    }
    await showCatalogPanel(ctx, { isOwner: owner })
  })

  bot.command('group', async (ctx) => {
    const args = ctx.message.text.replace(/^\/group\s*/, '').trim()
    if (!args) {
      const supabase = createSupabase()
      await showGroupPanel(ctx, { isOwner: isOwner(ctx.chat?.id), supabase })
      return
    }
    await handleGroupCommand(ctx, args)
  })

  bot.command('sizechart', async (ctx) => {
    const args = ctx.message.text.replace(/^\/sizechart\s*/, '').trim()
    await handleSizeChartCommand(ctx, args, { isOwner: isOwner(ctx.chat?.id) })
  })

  bot.command('postlink', async (ctx) => {
    if (!isOwner(ctx.chat?.id)) {
      await ctx.reply('শুধু Owner')
      return
    }
    const args = ctx.message.text.replace(/^\/postlink\s*/, '').trim().split(/\s+/)
    if (!args[0] || args.length < 2) {
      const supabase = createSupabase()
      await showPostlinkGuide(ctx, supabase)
      return
    }
    await handlePostlink(ctx, args)
  })

  bot.command('content', async (ctx) => {
    if (!isOwner(ctx.chat?.id)) {
      await ctx.reply('শুধু Owner')
      return
    }
    await showContentEngineStatus(ctx)
  })

  const csModeHandler = async (ctx, modeArg) => {
    if (!isOwner(ctx.chat?.id)) {
      await ctx.reply('শুধু Owner')
      return
    }
    await handleCsModeCommand(ctx, modeArg)
  }

  bot.command('cs', async (ctx) => {
    if (!isOwner(ctx.chat?.id)) {
      await ctx.reply('শুধু Owner')
      return
    }
    const args = ctx.message.text.replace(/^\/cs\s*/, '').trim().split(/\s+/)
    const sub = args[0]?.toLowerCase()
    if (!sub) {
      await showCsPanel(ctx)
      return
    }
    if (sub === 'status') await handleCsStatus(ctx)
    else if (sub === 'resume') await handleCsResume(ctx, args[1])
    else if (sub === 'followups') await handleCsFollowups(ctx, args[1]?.toLowerCase() === 'on')
    else if (sub === 'block') await handleCsBlock(ctx, args[1])
    else if (['off', 'shadow', 'night', 'auto'].includes(sub)) await handleCsModeCommand(ctx, sub)
    else await showCsPanel(ctx)
  })

  bot.command('csstatus', async (ctx) => {
    if (!isOwner(ctx.chat?.id)) { await ctx.reply('শুধু Owner'); return }
    await handleCsStatus(ctx)
  })
  bot.command('csshadow', (ctx) => csModeHandler(ctx, 'shadow'))
  bot.command('csauto', (ctx) => csModeHandler(ctx, 'auto'))
  bot.command('csoff', (ctx) => csModeHandler(ctx, 'off'))

  // ── Catalog photos (owner + staff) ────────────────────────────────────────

  bot.on('photo', async (ctx) => {
    const chatId = ctx.chat?.id
    const owner = isOwner(chatId)
    if (owner) {
      try {
        await handleCatalogPhotoMessage(ctx, { isOwner: true })
      } catch (err) {
        console.error('[telegram] catalog photo error:', err.message)
        await ctx.reply(`❌ ছবি সংরক্ষণ হয়নি: ${err.message}`)
      }
      return
    }
    const supabase = createSupabase()
    const staff = await resolveStaffByChatId(supabase, chatId)
    if (!staff) return
    try {
      const { handleStaffProofMessage } = await import('../staff/task-verification.mjs')
      const proofHandled = await handleStaffProofMessage(ctx, supabase, staff, { photo: ctx.message.photo })
      if (proofHandled) return

      const { markProofReceived } = await import('../staff/productivity-monitor.mjs')
      await markProofReceived(supabase, staff.id).catch(() => {})

      await handleCatalogPhotoMessage(ctx, { isOwner: false })
    } catch (err) {
      console.error('[telegram] catalog photo (staff) error:', err.message)
      await ctx.reply(`❌ ছবি সংরক্ষণ হয়নি: ${err.message}`)
    }
  })

  // ── Text messages ─────────────────────────────────────────────────────────

  bot.on('text', async (ctx) => {
    const chatId = ctx.chat?.id
    if (!isOwner(chatId)) {
      const supabase = createSupabase()
      const staff = await resolveStaffByChatId(supabase, chatId)
      if (!staff) return

      const text = ctx.message.text.trim()
      if (text === 'লোকেশন skip') {
        await ctx.reply('⚠️ লোকেশন শেয়ার *বাধ্যতামূলক*। 📍 বাটন চাপুন বা Attachment → Location শেয়ার করুন।', { parse_mode: 'Markdown' })
        return
      }

      const { markProofReceived } = await import('../staff/productivity-monitor.mjs')
      await markProofReceived(supabase, staff.id).catch(() => {})

      const { captureStaffFeedback } = await import('../staff/staff-feedback.mjs')
      const feedbackHandled = await captureStaffFeedback(ctx, supabase, staff, text)
      if (feedbackHandled) return

      const { isLunchStartText, isLunchEndText, handleLunchStart, handleLunchEnd } = await import('../staff/lunch.mjs')
      if (isLunchStartText(text)) {
        await handleLunchStart(ctx, supabase, staff)
        return
      }
      if (isLunchEndText(text)) {
        await handleLunchEnd(ctx, supabase, staff)
        return
      }

      const { isLeaveRequestText, handleLeaveRequest } = await import('../staff/leave-request.mjs')
      if (isLeaveRequestText(text)) {
        await handleLeaveRequest(ctx, supabase, staff)
        return
      }

      const { handleStaffProofMessage } = await import('../staff/task-verification.mjs')
      const proofHandled = await handleStaffProofMessage(ctx, supabase, staff, { text })
      if (proofHandled) return

      if (text.startsWith('/catalog') || text.startsWith('/group')) {
        if (text.startsWith('/catalog')) {
          const args = text.replace(/^\/catalog\s*/, '').trim()
          if (args === 'suggest') {
            await ctx.reply('❌ শুধু Owner।')
            return
          }
          await showCatalogPanel(ctx, { isOwner: false })
          return
        }
        const gArgs = text.replace(/^\/group\s*/, '').trim()
        if (!gArgs) {
          await showGroupPanel(ctx, { isOwner: false, supabase })
          return
        }
        await handleGroupCommand(ctx, gArgs)
        return
      }

      await ctx.reply(
        `ওয়ালাইকুম আসসালাম ${staff.name} ভাই! 🤲\n\n` +
          `• *ক্যাটালগ ছবি*: ফটো পাঠান, ক্যাপশনে প্রোডাক্ট কোড (যেমন FM-204)\n` +
          `• /catalog status — ছবির অগ্রগতি\n` +
          `• কাজের টাস্ক এলে ✅ Done চাপবেন`,
        { parse_mode: 'Markdown' },
      )
      return
    }
    dispatchOwnerText(ctx, ctx.message.text)
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
      dispatchOwnerText(ctx, transcribed)
    } catch (err) {
      console.error('[telegram] voice transcription error:', err.message)
      await ctx.reply(`❌ ভয়েস নোট প্রসেস করা যায়নি: ${err.message}`)
    }
  })

  // ── Callback queries (confirm cards + chats picker) ───────────────────────

  bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery.data ?? ''

    if (data === 'msg_ack_done') {
      await ctx.answerCbQuery('✅ ইতিমধ্যে নিশ্চিত')
      return
    }

    if (data.startsWith('autofix_approve:') || data.startsWith('autofix_reject:')) {
      if (!isOwner(ctx.chat?.id)) {
        await ctx.answerCbQuery('অনুমতি নেই')
        return
      }
      const [action, actionId] = data.split(':')
      const approved = action === 'autofix_approve'
      const supabase = createSupabase()
      const { data: row } = await supabase.from('agent_pending_actions')
        .select('id, payload, status')
        .eq('id', actionId)
        .single()
      if (!row || (row.status !== 'pending' && row.status !== 'waiting_list')) {
        await ctx.answerCbQuery('⚠ ইতিমধ্যে প্রসেস হয়েছে')
        return
      }
      await supabase.from('agent_pending_actions').update({
        status: approved ? 'approved' : 'rejected',
        resolved_at: new Date().toISOString(),
      }).eq('id', actionId)
      if (approved) {
        try {
          const { getDiagnosticPublicBase } = await import('../diagnostic-http.mjs')
          const base = getDiagnosticPublicBase()
          await fetch(`${base}/auto-fix-run`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${INT_TOKEN}`,
            },
            body: JSON.stringify({ actionId, issue: row.payload }),
          })
        } catch (err) {
          console.warn('[autofix-callback] dispatch failed:', err.message)
        }
      }
      await ctx.answerCbQuery(approved ? '✅ Auto-Fix শুরু হচ্ছে...' : '❌ বাতিল')
      try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }) } catch { /* already edited */ }
      return
    }

    if (data.startsWith('staff_approve:') || data.startsWith('staff_reject:')) {
      if (!isOwner(ctx.chat?.id)) {
        await ctx.answerCbQuery('অনুমতি নেই')
        return
      }
      const [action, actionId] = data.split(':')
      const approved = action === 'staff_approve'
      const supabase = createSupabase()
      const { data: row } = await supabase.from('agent_pending_actions')
        .select('id, payload, status')
        .eq('id', actionId)
        .single()
      if (!row || (row.status !== 'pending' && row.status !== 'waiting_list')) {
        await ctx.answerCbQuery(approved ? '⚠ ইতিমধ্যে প্রসেস হয়েছে' : '⚠ ইতিমধ্যে প্রসেস হয়েছে')
        return
      }
      await supabase.from('agent_pending_actions').update({
        status: approved ? 'approved' : 'rejected',
        resolved_at: new Date().toISOString(),
      }).eq('id', actionId)
      if (approved && row.payload?.chatId) {
        try {
          const { getDiagnosticPublicBase } = await import('../diagnostic-http.mjs')
          const base = getDiagnosticPublicBase()
          await fetch(`${base}/staff-send`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${INT_TOKEN}`,
            },
            body: JSON.stringify({ actionId, payload: row.payload }),
          })
        } catch (err) {
          console.warn('[staff-approval] dispatch failed:', err.message)
        }
      }
      await ctx.answerCbQuery(approved ? '✅ অনুমোদিত — মেসেজ পাঠানো হচ্ছে' : '❌ বাতিল')
      try {
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] })
      } catch { /* already edited */ }
      return
    }

    if (data.startsWith('bonus_approve:') || data.startsWith('bonus_edit:') || data.startsWith('bonus_dismiss:')) {
      const [action, actionId] = data.split(':')
      const { handleBonusCallback } = await import('./dispatcher.mjs')
      await handleBonusCallback(ctx, action, actionId)
      return
    }

    if (data.startsWith('approvals_show_all:')) {
      if (!isOwner(ctx.chat?.id)) {
        await ctx.answerCbQuery('অনুমতি নেই')
        return
      }
      const supabase = createSupabase()
      const { resendAllPendingApprovalCards } = await import('../approvals/resend-card.mjs')
      await resendAllPendingApprovalCards(ctx, supabase)
      return
    }

    if (data.startsWith('approvals_mute_today:')) {
      if (!isOwner(ctx.chat?.id)) {
        await ctx.answerCbQuery('অনুমতি নেই')
        return
      }
      const supabase = createSupabase()
      const { muteApprovalsForToday } = await import('../approvals/resend-card.mjs')
      await muteApprovalsForToday(supabase)
      await ctx.answerCbQuery('আজ চুপ')
      await ctx.reply('🔕 আজকের জন্য approval reminder বন্ধ। কাল থেকে আবার চালু হবে।')
      return
    }

    if (data.startsWith('fin_rm:')) {
      const [, actionId, idxStr] = data.split(':')
      const { handleFinanceRemove } = await import('../finance/confirm-cards.mjs')
      await handleFinanceRemove(ctx, APP_URL, INT_TOKEN, actionId, Number(idxStr))
      return
    }

    if (data.startsWith('fin_edit_f:')) {
      const [, actionId, field] = data.split(':')
      const { handleFinanceEditField } = await import('../finance/confirm-cards.mjs')
      await handleFinanceEditField(ctx, actionId, field, ownerState)
      return
    }

    if (data.startsWith('fin_edit_cancel:')) {
      ownerState.financeEdit = null
      await ctx.answerCbQuery('বাতিল')
      return
    }

    if (data.startsWith('fin_edit:')) {
      const actionId = data.slice('fin_edit:'.length)
      const { handleFinanceEditMenu } = await import('../finance/confirm-cards.mjs')
      await handleFinanceEditMenu(ctx, APP_URL, INT_TOKEN, actionId, ownerState)
      return
    }

    if (data.startsWith('proposal_approve:')) {
      const dateYmd = data.slice('proposal_approve:'.length)
      const supabase = createSupabase()
      const pa = await findPendingProposalAction(supabase, dateYmd)
      if (!pa?.id) {
        await ctx.answerCbQuery('কোনো pending proposal নেই')
        await ctx.reply('এই তারিখের জন্য approve করার মতো proposal পাওয়া যায়নি।')
        return
      }
      await handleActionCallback(ctx, 'approve', pa.id)
      return
    }

    if (data.startsWith('proposal_show:')) {
      const dateYmd = data.slice('proposal_show:'.length)
      const supabase = createSupabase()
      const pa = await findPendingProposalAction(supabase, dateYmd)
      await ctx.answerCbQuery('প্রস্তাব')
      if (pa?.summary) {
        await ctx.reply(pa.summary, { parse_mode: 'Markdown' }).catch(() => ctx.reply(pa.summary))
      } else {
        const { count } = await supabase
          .from('staff_tasks')
          .select('id', { count: 'exact', head: true })
          .eq('proposed_for', dateYmd)
          .eq('status', 'proposed')
        await ctx.reply(count
          ? `${dateYmd} তারিখে ${count}টি proposed task আছে — Approve করুন।`
          : `${dateYmd} তারিখে কোনো pending proposal নেই।`)
      }
      return
    }

    if (data.startsWith('proposal_edit:')) {
      const date = data.slice('proposal_edit:'.length)
      await ctx.answerCbQuery('সম্পাদনা')
      await ctx.reply(
        'কোন task edit করবেন? টাস্ক নম্বর আর নতুন লেখা বলুন, অথবা agent কে লিখুন।' +
        (date ? `\n\n(সক্রিয় প্রস্তাব: ${date})` : ''),
      )
      return
    }

    if (data.startsWith('proposal_addtask:')) {
      const date = data.slice('proposal_addtask:'.length)
      await ctx.answerCbQuery('যোগ করুন')
      await ctx.reply(
        'কোন staff-এর জন্য কী task যোগ করবো? লিখুন।' +
        (date ? `\n\n(সক্রিয় প্রস্তাব: ${date})` : ''),
      )
      return
    }

    if (data.startsWith('content_keep:') || data.startsWith('content_regen:')) {
      const parts = data.split(':')
      const action = parts[0] === 'content_keep' ? 'keep' : 'regenerate'
      const gate1Id = parts[1]
      const variant = parts[2]
      const { handleContentGate1Variant } = await import('../approvals/resend-card.mjs')
      await handleContentGate1Variant(ctx, gate1Id, variant, action)
      return
    }

    if (data.startsWith('ad_regen:')) {
      const parts = data.split(':')
      const gateId = parts[1]
      const creativeId = parts[2]
      const { handleAdCreativeRegen } = await import('../approvals/resend-card.mjs')
      await handleAdCreativeRegen(ctx, gateId, creativeId)
      return
    }

    if (data.startsWith('ads_opt_exec:')) {
      const parts = data.split(':')
      const gateId = parts[1]
      const recIndex = parts[2]
      const { handleAdsOptimizerExec } = await import('../approvals/resend-card.mjs')
      await handleAdsOptimizerExec(ctx, gateId, recIndex)
      return
    }

    if (data.startsWith('approve:') || data.startsWith('reject:') || data.startsWith('edit:')) {
      const [action, actionId] = data.split(':')
      if (action === 'edit') {
        const supabase = createSupabase()
        const { data: pendingAction } = await supabase
          .from('agent_pending_actions')
          .select('type, payload')
          .eq('id', actionId)
          .maybeSingle()
        if (pendingAction?.type === 'dispatch_staff_tasks') {
          const date = pendingAction.payload?.date ?? ''
          await ctx.answerCbQuery('সম্পাদনা')
          await ctx.reply(
            'কোন task edit করবেন? টাস্ক নম্বর আর নতুন লেখা বলুন, অথবা agent কে লিখুন।' +
            (date ? `\n\n(সক্রিয় প্রস্তাব: ${date})` : ''),
          )
          return
        }
        const { handleFinanceEditMenu } = await import('../finance/confirm-cards.mjs')
        await handleFinanceEditMenu(ctx, APP_URL, INT_TOKEN, actionId, ownerState)
      } else {
        await handleActionCallback(ctx, action, actionId)
      }

    } else if (data.startsWith('switch:')) {
      const convId = data.slice(7)
      ownerState.conversationId = convId
      await ctx.answerCbQuery('চ্যাট পরিবর্তন হয়েছে ✅')
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {})
      await ctx.reply('✅ চ্যাট পরিবর্তন হয়েছে।')

    } else if (data.startsWith('salah_done:') || data.startsWith('salah_later:')) {
      // salah_done:<waqt>:<status>[:YYYY-MM-DD]  |  salah_later:<waqt>[:YYYY-MM-DD]
      const parts  = data.split(':')
      const action = parts[0]
      const waqt   = parts[1]
      const status = parts[2]
      const maybeDate = parts[3] ?? parts[2]
      const dateYmd = /^\d{4}-\d{2}-\d{2}$/.test(maybeDate) ? maybeDate : null
      await handleSalahCallback(
        ctx,
        action,
        waqt,
        action === 'salah_done' ? status : undefined,
        dateYmd,
      )

    } else if (data.startsWith('reminder_done:') || data.startsWith('reminder_snooze:') || data.startsWith('reminder_cancel:')) {
      await handleReminderCallback(ctx, data)

    } else if (data === 'leave_request') {
      const supabase = createSupabase()
      const staff = await resolveStaffByChatId(supabase, ctx.chat?.id)
      if (!staff) {
        await ctx.answerCbQuery('অনুমতি নেই')
        return
      }
      const { handleLeaveRequest } = await import('../staff/leave-request.mjs')
      await handleLeaveRequest(ctx, supabase, staff)
      await ctx.answerCbQuery()

    } else if (data.startsWith('leave_approve:')) {
      const leaveId = data.slice('leave_approve:'.length)
      const supabase = createSupabase()
      const { handleLeaveApprove } = await import('../staff/leave-request.mjs')
      await handleLeaveApprove(ctx, supabase, leaveId, isOwner(ctx.chat?.id))

    } else if (data.startsWith('leave_reject:')) {
      const leaveId = data.slice('leave_reject:'.length)
      const supabase = createSupabase()
      const { handleLeaveReject } = await import('../staff/leave-request.mjs')
      await handleLeaveReject(ctx, supabase, leaveId, isOwner(ctx.chat?.id))

    } else if (data === 'lunch_start' || data === 'lunch_end') {
      const supabase = createSupabase()
      const staff = await resolveStaffByChatId(supabase, ctx.chat?.id)
      if (!staff) {
        await ctx.answerCbQuery('অনুমতি নেই')
        return
      }
      const { handleLunchStart, handleLunchEnd } = await import('../staff/lunch.mjs')
      if (data === 'lunch_start') await handleLunchStart(ctx, supabase, staff)
      else await handleLunchEnd(ctx, supabase, staff)
      await ctx.answerCbQuery()

    } else if (data.startsWith('staff_feedback_open:')) {
      const staffId = data.slice('staff_feedback_open:'.length)
      const supabase = createSupabase()
      const staff = await resolveStaffByChatId(supabase, ctx.chat?.id)
      if (!staff || staff.id !== staffId) {
        await ctx.answerCbQuery('অনুমতি নেই')
        return
      }
      const { handleStaffFeedbackOpen } = await import('../staff/staff-feedback.mjs')
      await handleStaffFeedbackOpen(ctx, staffId)

    } else if (data.startsWith('msg_ack:')) {
      const shortId = data.slice('msg_ack:'.length)
      const supabase = createSupabase()
      const staff = await resolveStaffByChatId(supabase, ctx.chat?.id)
      if (!staff) {
        await ctx.answerCbQuery('অনুমতি নেই')
        return
      }

      const fullId = parseTaskIdFromCallback(shortId)
      const { data: row } = await supabase
        .from('agent_outbox')
        .select('id, staff_id, acknowledged_at, requires_ack, telegram_message_id')
        .or(`short_id.eq.${shortId},id.eq.${fullId}`)
        .maybeSingle()

      if (!row || row.staff_id !== staff.id) {
        await ctx.answerCbQuery('মেসেজ পাওয়া যায়নি')
        return
      }
      if (!row.acknowledged_at) {
        await supabase
          .from('agent_outbox')
          .update({ acknowledged_at: new Date().toISOString() })
          .eq('id', row.id)
      }

      await ctx.answerCbQuery('✅ ধন্যবাদ! দেখেছেন বলে নিশ্চিত করা হলো।')

      if (row.telegram_message_id && ctx.chat?.id) {
        try {
          const msg = ctx.callbackQuery.message
          const existing = msg?.reply_markup?.inline_keyboard ?? []
          const filtered = existing
            .map((r) => r.filter((b) => !String(b.callback_data ?? '').startsWith('msg_ack:')))
            .filter((r) => r.length > 0)
          filtered.push([{ text: '✅ দেখেছেন', callback_data: 'msg_ack_done' }])
          await ctx.telegram.editMessageReplyMarkup(
            ctx.chat.id,
            Number(row.telegram_message_id),
            undefined,
            { inline_keyboard: filtered },
          )
        } catch {
          /* non-fatal */
        }
      }
      return

    } else if (data.startsWith('task_done:')) {
      const taskId = parseTaskIdFromCallback(data.slice('task_done:'.length))
      const supabase = createSupabase()
      const staff = await resolveStaffByChatId(supabase, ctx.chat?.id)
      if (!staff) {
        await ctx.answerCbQuery('অনুমতি নেই')
        return
      }
      try {
        const { handleStaffTaskDone } = await import('../staff/task-verification.mjs')
        const outcome = await handleStaffTaskDone(ctx, supabase, taskId, staff)

        if (outcome.instant) {
          await ctx.answerCbQuery('✅ Done!')
        } else if (outcome.autoVerified) {
          await ctx.answerCbQuery('✅ যাচাই হয়েছে — Boss অনুমোদনের অপেক্ষায়')
        } else {
          await ctx.answerCbQuery('📸 প্রমাণ পাঠান')
        }

        try {
          const origMsg = ctx.callbackQuery?.message
          if (origMsg?.text && origMsg?.reply_markup?.inline_keyboard) {
            const doneTaskCompact = data.slice('task_done:'.length)
            const updatedRows = origMsg.reply_markup.inline_keyboard
              .map((row) => row.map((btn) => {
                if (btn.callback_data?.endsWith(doneTaskCompact)) {
                  return { text: btn.text.replace('✅', '☑️'), callback_data: `noop:${doneTaskCompact}` }
                }
                return btn
              }))
            const allDone = updatedRows.flat().every((btn) => btn.callback_data?.startsWith('noop:'))
            await ctx.editMessageReplyMarkup({
              inline_keyboard: allDone ? [] : updatedRows,
            })
          } else {
            await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {})
          }
        } catch {
          await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {})
        }

        if (outcome.instant && OWNER_ID && outcome.result?.staffName) {
          const { notifyStaffTaskProgress, resolveTaskProgressContext } = await import('../staff/task-progress.mjs')
          const progressCtx = await resolveTaskProgressContext(supabase, taskId).catch(() => null)
          const dateYmd = progressCtx?.dateYmd ?? new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
          const todayTasks = await notifyStaffTaskProgress(
            ctx.telegram,
            supabase,
            OWNER_ID,
            {
              staffId: staff.id,
              staffName: outcome.result.staffName,
              dateYmd,
              approvedTaskId: taskId,
              approvedTitle: outcome.result.taskTitle,
            },
          ).catch((err) => {
            console.warn('[telegram] task progress notify failed:', err.message)
            return []
          })

          const active = (todayTasks ?? []).filter((t) => t.status !== 'cancelled')
          const allTasksDone = active.length > 0 && active.every((t) => t.status === 'done')
          if (allTasksDone) {
            const { suggestBonusTasks } = await import('../staff/bonus-task-suggest.mjs')
            await suggestBonusTasks({
              supabase,
              telegram: ctx.telegram,
              staff,
              today: dateYmd,
              existingTasks: active,
            }).catch((err) => console.warn('[telegram] bonus suggest failed:', err.message))
          }
        }
      } catch (err) {
        await ctx.answerCbQuery('সমস্যা হয়েছে')
        console.error('[telegram] task_done callback error:', err.message)
      }

    } else if (data.startsWith('task_vfy_ok:')) {
      if (!isOwner(ctx.chat?.id)) {
        await ctx.answerCbQuery('অনুমতি নেই')
        return
      }
      const taskId = parseTaskIdFromCallback(data.slice('task_vfy_ok:'.length))
      const supabase = createSupabase()
      try {
        const { finalizeOwnerApprove } = await import('../staff/task-verification.mjs')
        const { fetchStaffTasksForDay } = await import('../staff/task-progress.mjs')
        const result = await finalizeOwnerApprove(ctx, supabase, taskId)

        const dateYmd = result.proposedFor
          ?? new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
        const todayTasks = await fetchStaffTasksForDay(supabase, result.staffId, dateYmd)

        const active = todayTasks.filter((t) => t.status !== 'cancelled')
        const allTasksDone = active.length > 0 && active.every((t) => t.status === 'done')
        if (allTasksDone) {
          const { data: staffRow } = await supabase
            .from('agent_staff')
            .select('*')
            .eq('id', result.staffId)
            .single()
          if (staffRow) {
            const { suggestBonusTasks } = await import('../staff/bonus-task-suggest.mjs')
            await suggestBonusTasks({
              supabase,
              telegram: ctx.telegram,
              staff: staffRow,
              today: dateYmd,
              existingTasks: active,
            }).catch(() => {})
          }
        }
      } catch (err) {
        await ctx.answerCbQuery('সমস্যা হয়েছে')
        console.error('[telegram] task_vfy_ok error:', err.message)
      }

    } else if (data.startsWith('task_vfy_redo:')) {
      if (!isOwner(ctx.chat?.id)) {
        await ctx.answerCbQuery('অনুমতি নেই')
        return
      }
      const taskId = parseTaskIdFromCallback(data.slice('task_vfy_redo:'.length))
      try {
        const { startOwnerRedo } = await import('../staff/task-verification.mjs')
        await startOwnerRedo(ctx, taskId)
      } catch (err) {
        await ctx.answerCbQuery('সমস্যা হয়েছে')
        console.error('[telegram] task_vfy_redo error:', err.message)
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
        dispatchOwnerText(ctx, option)
      } catch (err) {
        await ctx.answerCbQuery(`সমস্যা: ${err.message}`)
      }

    } else if (data.startsWith('loc_skip:')) {
      await ctx.answerCbQuery('বাধ্যতামূলক')
      await ctx.reply('⚠️ লোকেশন শেয়ার বাধ্যতামূলক — skip করা যাবে না।')

    } else if (data.startsWith('details:')) {
      // details:<name>:<page>  — owner's paginated finance details
      if (isOwner(ctx.chat?.id)) {
        const [, name, pageStr] = data.split(':')
        const supabase = createSupabase()
        await ctx.answerCbQuery()
        await handleDetailsCommand(ctx, name, supabase, parseInt(pageStr || '0', 10))
      }

    } else if (data.startsWith('details_pick:')) {
      if (isOwner(ctx.chat?.id)) {
        const index = parseInt(data.slice('details_pick:'.length), 10)
        const supabase = createSupabase()
        await ctx.answerCbQuery()
        await handleDetailsPick(ctx, supabase, index)
      } else {
        await ctx.answerCbQuery('শুধু Owner')
      }

    } else if (data.startsWith('ask_go:')) {
      if (!isOwner(ctx.chat?.id)) {
        await ctx.answerCbQuery('শুধু Owner')
        return
      }
      const index = parseInt(data.slice('ask_go:'.length), 10)
      const query = getAskExample(index)
      if (!query) {
        await ctx.answerCbQuery('প্রশ্ন পাওয়া যায়নি')
        return
      }
      await ctx.answerCbQuery()
      await handleAskCommand(ctx, `/ask ${query}`, sendToAgent, ownerState)

    } else if (data === 'group:suggest') {
      if (isOwner(ctx.chat?.id)) {
        await handleGroupSuggestCallback(ctx)
      } else {
        await ctx.answerCbQuery('শুধু Owner')
      }

    } else if (data === 'group:help') {
      await ctx.answerCbQuery()
      await showGroupHelp(ctx)

    } else if (data === 'catalog:refresh') {
      await ctx.answerCbQuery('আপডেট…')
      await showCatalogPanel(ctx, { isOwner: isOwner(ctx.chat?.id) })

    } else if (data === 'catalog:guide') {
      await ctx.answerCbQuery()
      await showCatalogGuide(ctx)

    } else if (data === 'catalog:suggest') {
      if (isOwner(ctx.chat?.id)) {
        await ctx.answerCbQuery()
        await handleCatalogSuggest(ctx)
      } else {
        await ctx.answerCbQuery('শুধু Owner')
      }

    } else if (data.startsWith('cat_del_') || data.startsWith('csg_')) {
      if (isOwner(ctx.chat?.id)) {
        await handleCatalogCallback(ctx, data, { isOwner: true })
      } else {
        await ctx.answerCbQuery('শুধু Owner')
      }

    } else if (data.startsWith('menu:')) {
      if (isOwner(ctx.chat?.id)) {
        const action = data.slice('menu:'.length)
        const supabase = createSupabase()
        await handleMenuCallback(ctx, action, {
          supabase,
          handleCsStatus,
          handleCsModeCommand,
          handleCsFollowups,
        })
      } else {
        await ctx.answerCbQuery('শুধু Owner')
      }

    } else if (data.startsWith('cs_send:')) {
      if (isOwner(ctx.chat?.id)) {
        await handleCsSendDraft(ctx, data.slice('cs_send:'.length))
      } else {
        await ctx.answerCbQuery('অনুমতি নেই')
      }

    } else if (data.startsWith('cs_confirm:')) {
      if (isOwner(ctx.chat?.id)) {
        await handleCsConfirmOrder(ctx, data.slice('cs_confirm:'.length))
      } else {
        await ctx.answerCbQuery('অনুমতি নেই')
      }

    } else if (data.startsWith('postlink_ok:')) {
      if (isOwner(ctx.chat?.id)) {
        const [, pageId, postId, code] = data.split(':')
        await ctx.answerCbQuery('লিঙ্ক হচ্ছে…')
        const res = await fetch(`${APP_URL}/api/assistant/internal/cs-postlink`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INT_TOKEN}` },
          body: JSON.stringify({ postRef: postId, pageId, productCodes: [code] }),
        })
        if (res.ok) await ctx.reply(`✅ Post ${postId} → ${code}`)
        else await ctx.reply('❌ postlink failed')
      }

    } else if (data.startsWith('postlink_skip:')) {
      await ctx.answerCbQuery('Skip')

    } else if (data.startsWith('cs_edit:')) {
      const draftId = data.slice('cs_edit:'.length)
      await ctx.answerCbQuery()
      await ctx.reply(`✏️ Draft ${draftId} — Telegram-এ এডিট করে /cs resume বা নতুন মেসেজ পাঠান`)

    } else if (data.startsWith('msg_draft:') || data.startsWith('staff_feedback:')) {
      // Messenger alert callbacks — owner-only (conv id only — fits 64-byte limit)
      if (isOwner(ctx.chat?.id)) {
        const action = data.startsWith('msg_draft:') ? 'msg_draft' : 'staff_feedback'
        const convId = data.slice(action.length + 1)
        await ctx.answerCbQuery()
        if (action === 'msg_draft') {
          await ctx.reply(
            'নতুন draft চাইছেন — agent-কে জিজ্ঞেস করুন: "Conversation ' + convId + '-এর জন্য draft দাও"',
          )
        } else {
          await ctx.reply(
            'স্টাফকে feedback পাঠানোর জন্য বলুন: "Conversation ' + convId + '-এ staff-কে feedback দাও"',
          )
        }
      }

    } else {
      await ctx.answerCbQuery()
    }
  })

  // Register bot with notify module so Tier 1+ can use it
  setTelegramForNotify(bot, OWNER_ID)

  bot.catch((err) => {
    console.error('[telegram] polling error:', err.message)
    captureWorkerError('telegram.polling', err)
  })

  void registerBotCommands(bot, OWNER_ID)

  return bot
}
