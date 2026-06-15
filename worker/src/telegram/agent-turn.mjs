/**
 * Background agent turns for Telegram — avoids Vercel 120s wall blocking replies.
 */
import { createClient } from '@supabase/supabase-js'
import { captureWorkerError } from '../sentry.mjs'
import { safeLogMessage } from '../log-safe.mjs'
import { replyMarkdownSafe } from './markdown-safe.mjs'
import { sendVoiceMessage } from './voice.mjs'
import { ownerState, releaseOwnerTurn } from './owner-state.mjs'
import { getDispatcherBot } from './dispatcher.mjs'

import { Queue } from 'bullmq'

const APP_URL = process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = process.env.AGENT_INTERNAL_TOKEN ?? ''
/** Just under Vercel 300s limit */
const AGENT_FETCH_TIMEOUT_MS = 290_000

function createSupabase() {
  return createClient(
    process.env.SUPABASE_URL ?? '',
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  )
}

export async function callAgentApi(userMessage, conversationId, { personalMode = false } = {}) {
  const res = await fetch(`${APP_URL}/api/assistant/chat?stream=false`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${INT_TOKEN}`,
      'X-Agent-Source': 'telegram',
    },
    body: JSON.stringify({
      message: userMessage,
      conversationId: conversationId ?? undefined,
      personalMode: personalMode || undefined,
      source: 'telegram',
    }),
    signal: AbortSignal.timeout(AGENT_FETCH_TIMEOUT_MS),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Agent API ${res.status}: ${err}`)
  }
  return res.json()
}

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

function formatAgentError(err) {
  const msg = err?.message ?? String(err)
  if (/rate_limited|429/i.test(msg)) {
    return 'অনেক দ্রুত মেসেজ পাঠানো হচ্ছে। এক মিনিট পরে আবার চেষ্টা করুন।'
  }
  if (/quota|credit|billing/i.test(msg)) {
    return 'API কোটা শেষ — মালিককে জানানো হয়েছে।'
  }
  if (/504|FUNCTION_INVOCATION_TIMEOUT|timed out|TimeoutError/i.test(msg)) {
    return 'উত্তর প্রস্তুত হতে বেশি সময় লাগছে। /new দিয়ে নতুন চ্যাট শুরু করে ছোট করে আবার লিখুন।'
  }
  return 'সমস্যা হয়েছে। /new দিয়ে নতুন চ্যাট শুরু করে আবার চেষ্টা করুন।'
}

let agentTurnQueue = null

function getConnection() {
  const url = process.env.REDIS_URL
  if (!url) throw new Error('REDIS_URL missing')
  return { url }
}

export function getAgentTurnQueue() {
  if (!agentTurnQueue) {
    agentTurnQueue = new Queue('agent-turn', {
      connection: getConnection(),
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: 80,
        removeOnFail: 40,
      },
    })
  }
  return agentTurnQueue
}

export async function enqueueAgentTurn(data) {
  const job = await getAgentTurnQueue().add('turn', data, {
    jobId: `turn-${data.chatId}-${Date.now()}`,
  })
  safeLogMessage('[telegram] agent-turn queued', `[chat=${data.chatId} job=${job.id}]`)
  return job
}

/**
 * Run agent turn and deliver reply to owner Telegram chat.
 */
export async function deliverAgentTurn(jobData) {
  const {
    chatId,
    text,
    conversationId,
    personalMode = false,
    wantsVoice = false,
  } = jobData

  const bot = getDispatcherBot()
  if (!bot) throw new Error('Telegram bot not ready')

  const started = Date.now()
  safeLogMessage('[telegram] agent-turn start', `[chat=${chatId} len=${String(text ?? '').length}]`)

  let typingInterval
  try {
    typingInterval = setInterval(() => {
      bot.telegram.sendChatAction(chatId, 'typing').catch(() => {})
    }, 4000)
    await bot.telegram.sendChatAction(chatId, 'typing')

    const result = await callAgentApi(text, conversationId, { personalMode })

    if (result.conversationId) {
      if (personalMode) ownerState.personalConversationId = result.conversationId
      else ownerState.conversationId = result.conversationId
    }

    const replyText = result.text || '(কোনো উত্তর নেই)'
    const chunks = splitMessage(replyText)
    for (const chunk of chunks) {
      await bot.telegram.sendMessage(chatId, chunk, { parse_mode: 'Markdown' }).catch(() =>
        bot.telegram.sendMessage(chatId, chunk),
      )
    }

    if (process.env.GOOGLE_TTS_CREDENTIALS && wantsVoice) {
      try {
        await sendVoiceMessage(bot.telegram, chatId, replyText)
      } catch (ttsErr) {
        console.warn('[telegram] TTS voice reply failed:', ttsErr.message)
      }
    }

    const miniCtx = {
      telegram: bot.telegram,
      chat: { id: chatId },
      reply: (m, o) => bot.telegram.sendMessage(chatId, m, o),
    }

    const supabase = createSupabase()
    for (const card of result.pendingCards ?? []) {
      const { data: row } = await supabase
        .from('agent_pending_actions')
        .select('status, summary')
        .eq('id', card.pendingActionId)
        .maybeSingle()
      if (row?.status !== 'pending') continue
      const summary = card.summary || row.summary || ''
      if (!summary.trim()) continue
      const keyboard = await buildConfirmCardKeyboard(card)
      await replyMarkdownSafe(miniCtx, `📋 *অনুমোদন প্রয়োজন*\n${summary}`, {
        reply_markup: { inline_keyboard: keyboard },
      })
    }

    const { sendAskCardTelegram } = await import('./quick-commands.mjs')
    for (const ask of result.askCards ?? []) {
      await sendAskCardTelegram(miniCtx, ask)
    }

    if (result.newConversationId) {
      if (personalMode) ownerState.personalConversationId = result.newConversationId
      else ownerState.conversationId = result.newConversationId
      await bot.telegram.sendMessage(chatId, '💬 কথোপকথন কম্প্যাক্ট — নতুন চ্যাট শুরু। বলুন স্যার।')
    }

    const elapsed = ((Date.now() - started) / 1000).toFixed(1)
    safeLogMessage('[telegram] agent-turn done', `[chat=${chatId} ${elapsed}s]`)
  } catch (err) {
    captureWorkerError(err, 'worker.telegram.agent_turn')
    safeLogMessage('[telegram] agent-turn error:', err.message)
    await bot.telegram.sendMessage(chatId, `❌ ${formatAgentError(err)}`).catch(() => {})
    throw err
  } finally {
    clearInterval(typingInterval)
    releaseOwnerTurn(chatId)
  }
}
