import { sendMarkdownSafe } from '../telegram/markdown-safe.mjs'
import { buildFinanceKeyboard } from '../finance/confirm-cards.mjs'
import {
  sendTelegramApprovalCard,
  sendBonusSuggestCard,
  buildStaffProposalKeyboard,
  getDispatcherBot,
} from '../telegram/dispatcher.mjs'

const FINANCE_TYPES = new Set([
  'log_expense',
  'log_ledger_entry',
  'log_expenses_batch',
  'log_ledger_entries_batch',
  'delete_finance_entry',
  'edit_finance_entry',
])

function splitMessage(text, limit = 4000) {
  const chunks = []
  let remaining = String(text ?? '')
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf('\n', limit)
    if (splitAt < limit * 0.5) splitAt = limit
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).trimStart()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

function genericKeyboard(actionId) {
  return {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: `approve:${actionId}` },
      { text: '❌ Cancel', callback_data: `reject:${actionId}` },
    ]],
  }
}

/**
 * Re-send one pending action's approval card to the owner.
 */
export async function resendApprovalCard(telegram, ownerChatId, row) {
  if (!ownerChatId || !row?.id) return false

  const actionId = row.id
  const summary = row.summary ?? `Pending: ${row.type}`
  const payload = row.payload ?? {}

  if (row.type === 'dispatch_staff_tasks') {
    const result = await sendTelegramApprovalCard({
      message: summary,
      pendingActionId: actionId,
      proposalDate: payload.date ?? '',
    })
    return result.cardSent
  }

  if (row.type === 'bonus_task_suggest') {
    await sendBonusSuggestCard({ message: summary, pendingActionId: actionId })
    return true
  }

  if (FINANCE_TYPES.has(row.type)) {
    const isBatch = row.type.includes('batch')
    const entryCount = Array.isArray(payload.entries)
      ? payload.entries.length
      : (payload.entryCount ?? 0)
    const card = {
      pendingActionId: actionId,
      summary,
      isBatch,
      entryCount,
      isFinance: true,
    }
    const chunks = splitMessage(`📋 *অনুমোদন প্রয়োজন*\n${summary}`)
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1
      await sendMarkdownSafe(telegram, ownerChatId, chunks[i], {
        reply_markup: isLast ? { inline_keyboard: buildFinanceKeyboard(card) } : undefined,
      })
    }
    return true
  }

  const chunks = splitMessage(`📋 *অনুমোদন প্রয়োজন*\n${summary}`)
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1
    let keyboard = null
    if (isLast) {
      if (row.type === 'dispatch_staff_tasks') {
        keyboard = buildStaffProposalKeyboard(actionId, payload.date ?? '')
      } else {
        keyboard = genericKeyboard(actionId)
      }
    }
    await sendMarkdownSafe(telegram, ownerChatId, chunks[i], {
      reply_markup: keyboard ?? undefined,
    })
  }
  return true
}

export async function resendAllPendingApprovalCards(ctx, supabase) {
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  const { data: pending } = await supabase
    .from('agent_pending_actions')
    .select('*')
    .eq('status', 'pending')
    .order('createdAt', { ascending: true })

  if (!pending?.length) {
    await ctx.answerCbQuery('কিছু নেই')
    await ctx.reply('✅ কোনো pending approval নেই।')
    return
  }

  await ctx.answerCbQuery(`${pending.length}টি কার্ড`)
  const bot = getDispatcherBot()
  const telegram = bot?.telegram ?? ctx.telegram

  for (const row of pending) {
    await resendApprovalCard(telegram, ownerChatId ?? String(ctx.chat?.id), row)
  }

  await ctx.reply(`📋 ${pending.length}টি pending approval কার্ড পাঠানো হয়েছে।`)
}

export async function muteApprovalsForToday(supabase) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
  const key = `approvals_muted_${today}`
  await supabase.from('agent_kv_settings').upsert({
    key,
    value: 'true',
    updated_at: new Date().toISOString(),
  })
}
