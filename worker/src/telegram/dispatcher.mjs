/**
 * Telegram dispatcher helpers.
 * Sends approval cards and staff messages; handles Phase 6 callbacks.
 */

import { createClient } from '@supabase/supabase-js'
import { sendMarkdownSafe } from './markdown-safe.mjs'
import { dispatchTasksToStaff, formatDispatchOwnerReport } from '../staff/dispatch.mjs'

let _bot = null
let _ownerChatId = null

function createSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
}

export function setDispatcherBot(bot, ownerChatId) {
  _bot = bot
  _ownerChatId = String(ownerChatId)
}

/**
 * Sends an approval card to the owner.
 */
export async function sendTelegramApprovalCard({
  message,
  pendingActionId,
  proposalDate,
  approveLabel = '✅ Approve',
  rejectLabel = '❌ Cancel',
}) {
  if (!_bot || !_ownerChatId) {
    console.warn('[dispatcher] bot not initialized for approval card')
    return
  }
  if (!pendingActionId) {
    console.error('[dispatcher] pendingActionId is missing — buttons will not be attached')
  }

  const chunks = splitMessage(message)
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1
    const date = proposalDate ?? ''
    const keyboard = isLast && pendingActionId
      ? {
          inline_keyboard: [
            [
              { text: approveLabel, callback_data: `approve:${pendingActionId}` },
              { text: '✏️ Edit', callback_data: `proposal_edit:${date}` },
            ],
            [
              { text: '➕ Add Task', callback_data: `proposal_addtask:${date}` },
              { text: rejectLabel, callback_data: `reject:${pendingActionId}` },
            ],
          ],
        }
      : undefined
    const extra = keyboard ? { reply_markup: keyboard } : {}
    if (isLast) {
      console.log('[dispatcher] sendMessage args:', JSON.stringify({
        chatId: _ownerChatId,
        textLen: chunks[i].length,
        reply_markup: extra.reply_markup ?? null,
      }))
    }
    await sendMarkdownSafe(
      _bot.telegram,
      _ownerChatId,
      chunks[i],
      extra,
    )
  }
}

/**
 * Bonus task suggestion card (all daily tasks completed early).
 */
export async function sendBonusSuggestCard({ message, pendingActionId }) {
  if (!_bot || !_ownerChatId) {
    console.warn('[dispatcher] bot not initialized for bonus suggest card')
    return
  }
  if (!pendingActionId) {
    console.error('[dispatcher] pendingActionId missing for bonus suggest card')
  }

  const chunks = splitMessage(message)
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1
    const buttons = [
      { text: '✅ সব Approve', callback_data: `bonus_approve:${pendingActionId}` },
      { text: '✏️ Edit', callback_data: `bonus_edit:${pendingActionId}` },
      { text: '❌ আজ আর না', callback_data: `bonus_dismiss:${pendingActionId}` },
    ]
    const extra = isLast && pendingActionId
      ? { reply_markup: { inline_keyboard: [buttons] } }
      : {}
    await sendMarkdownSafe(_bot.telegram, _ownerChatId, chunks[i], extra)
  }
}

/**
 * Handle bonus task suggestion callbacks (worker-side, no Vercel round-trip).
 */
export async function handleBonusCallback(ctx, action, actionId) {
  const supabase = createSupabase()

  const { data: pendingAction, error } = await supabase
    .from('agent_pending_actions')
    .select('id, type, payload, status')
    .eq('id', actionId)
    .maybeSingle()

  if (error || !pendingAction) {
    await ctx.answerCbQuery('কার্ড পাওয়া যায়নি')
    return
  }
  if (pendingAction.type !== 'bonus_task_suggest') {
    await ctx.answerCbQuery('অনুমতি নেই')
    return
  }
  if (pendingAction.status !== 'pending') {
    await ctx.answerCbQuery('ইতিমধ্যে প্রক্রিয়া হয়েছে')
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {})
    return
  }

  const { staffId, staffName, date, taskIds } = pendingAction.payload ?? {}
  const now = new Date().toISOString()

  if (action === 'bonus_dismiss') {
    await ctx.answerCbQuery('বাতিল')
    if (taskIds?.length) {
      await supabase.from('staff_tasks').update({ status: 'cancelled' }).in('id', taskIds)
    }
    await supabase
      .from('agent_pending_actions')
      .update({ status: 'rejected', resolvedAt: now })
      .eq('id', actionId)
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {})
    await ctx.reply(`❌ ${staffName ?? 'স্টাফ'}-এর জন্য আজ আর বোনাস কাজ যোগ করা হবে না।`)
    return
  }

  if (action === 'bonus_edit') {
    await ctx.answerCbQuery('সম্পাদনা')
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {})
    await ctx.reply(
      `✏️ ${staffName ?? 'স্টাফ'}-এর নতুন কাজ লিখে পাঠান, অথবা এজেন্টকে বলুন কোন কাজগুলো পাঠাতে হবে।`,
    )
    return
  }

  if (action === 'bonus_approve') {
    await ctx.answerCbQuery('⏳ পাঠানো হচ্ছে…')
    if (taskIds?.length) {
      await supabase.from('staff_tasks').update({ status: 'approved' }).in('id', taskIds)
    }
    await supabase
      .from('agent_pending_actions')
      .update({ status: 'approved', resolvedAt: now })
      .eq('id', actionId)

    let dispatchResult = null
    if (_bot && date && taskIds?.length) {
      dispatchResult = await dispatchTasksToStaff({
        supabase,
        bot: _bot,
        date,
        taskIds,
      })
    }

    await supabase
      .from('agent_pending_actions')
      .update({ status: 'executed', resolvedAt: now })
      .eq('id', actionId)

    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {})
    const report = formatDispatchOwnerReport(dispatchResult)
    await ctx.reply(
      report ?? `✅ ${staffName ?? 'স্টাফ'}-কে ${taskIds?.length ?? 0}টি বোনাস কাজ পাঠানোর চেষ্টা করা হয়েছে।`,
    )
    return
  }

  await ctx.answerCbQuery('অজানা অ্যাকশন')
}

function splitMessage(text, limit = 4000) {
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
