import { sendMarkdownSafe } from '../telegram/markdown-safe.mjs'
import { buildFinanceKeyboard } from '../finance/confirm-cards.mjs'
import {
  sendTelegramApprovalCard,
  sendBonusSuggestCard,
  buildStaffProposalKeyboard,
  getDispatcherBot,
} from '../telegram/dispatcher.mjs'

const APP_URL = process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = process.env.AGENT_INTERNAL_TOKEN ?? ''

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

  if (row.type === 'content_gate1' && payload.stage === 'gate1_ready') {
    const chunks = splitMessage(`📋 *অনুমোদন প্রয়োজন*\n${summary}`)
    const keyboard = buildContentGate1KeyboardFromPayload(actionId, payload)
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1
      await sendMarkdownSafe(telegram, ownerChatId, chunks[i], {
        reply_markup: isLast ? keyboard : undefined,
      })
    }
    return true
  }

  if (row.type === 'ad_creative_gate') {
    const chunks = splitMessage(`📋 *Ad Creative Gate*\n${summary}`)
    const keyboard = buildAdCreativeKeyboardFromPayload(actionId, payload)
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1
      await sendMarkdownSafe(telegram, ownerChatId, chunks[i], {
        reply_markup: isLast ? keyboard : undefined,
      })
    }
    return true
  }

  if (row.type === 'ads_optimizer_batch') {
    const chunks = splitMessage(`📋 *Ad Optimizer*\n${summary}`)
    const keyboard = buildAdsOptimizerKeyboardFromPayload(actionId, payload)
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1
      await sendMarkdownSafe(telegram, ownerChatId, chunks[i], {
        reply_markup: isLast ? keyboard : undefined,
      })
    }
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

/** Gate 1 keyboard — keep/regenerate per variant (mirrors pipeline buildContentGate1Keyboard). */
export function buildContentGate1KeyboardFromPayload(gate1Id, payload) {
  const VARIANT_LABELS = {
    single: 'সিঙ্গেল',
    father_son: 'বাবা+ছেলে',
    mother_son: 'মা+ছেলে',
    full_family: 'ফ্যামিলি',
  }
  const rows = []
  for (const v of payload.variants ?? []) {
    if (!v.framedImagePath) continue
    const label = VARIANT_LABELS[v.key] ?? v.key
    const keepIcon = v.keep !== false ? '✅' : '⬜'
    rows.push([
      { text: `${keepIcon} ${label}`, callback_data: `content_keep:${gate1Id}:${v.key}` },
      { text: `🔄 ${label}`, callback_data: `content_regen:${gate1Id}:${v.key}` },
    ])
  }
  const keptCount = (payload.variants ?? []).filter((v) => v.keep !== false && v.framedImagePath).length
  rows.push([
    { text: `✅ Approve (${keptCount}) → PRO`, callback_data: `approve:${gate1Id}` },
    { text: '❌ বাতিল', callback_data: `reject:${gate1Id}` },
  ])
  return { inline_keyboard: rows }
}

export async function handleContentGate1Variant(ctx, gate1Id, variant, action) {
  const res = await fetch(`${APP_URL}/api/assistant/internal/content-gate1-variant`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${INT_TOKEN}`,
    },
    body: JSON.stringify({ gate1Id, variant, action }),
  })
  const data = await res.json()
  if (!res.ok) {
    await ctx.answerCbQuery(`❌ ${data.error ?? 'failed'}`)
    return false
  }
  await ctx.answerCbQuery(action === 'keep' ? (data.keep ? '✅ রাখা' : '⬜ বাদ') : '🔄 রিজেনারেট…')
  if (action === 'keep' && data.summary && data.keyboard) {
    await ctx.editMessageText(`📋 *অনুমোদন প্রয়োজন*\n${data.summary}`, {
      parse_mode: 'Markdown',
      reply_markup: data.keyboard,
    }).catch(() => {
      ctx.reply(`📋 ${data.summary}`, { reply_markup: data.keyboard }).catch(() => {})
    })
  } else if (action === 'regenerate' && data.summary) {
    await ctx.reply(`🔄 ${variant} রিজেনারেট কিউ হয়েছে…`)
  }
  return true
}

/** Ad creative gate keyboard — regen per creative + approve/reject. */
export function buildAdCreativeKeyboardFromPayload(gateId, payload) {
  const rows = []
  for (const c of payload.creatives ?? []) {
    rows.push([
      {
        text: `🔄 ${String(c.angle ?? c.id).slice(0, 14)} (${c.aspect ?? ''})`,
        callback_data: `ad_regen:${gateId}:${c.id}`,
      },
    ])
  }
  rows.push([
    { text: '✅ Approve creatives', callback_data: `approve:${gateId}` },
    { text: '❌ বাতিল', callback_data: `reject:${gateId}` },
  ])
  return { inline_keyboard: rows }
}

export async function handleAdCreativeRegen(ctx, gateId, creativeId) {
  const res = await fetch(`${APP_URL}/api/assistant/internal/ad-creative-gate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${INT_TOKEN}`,
    },
    body: JSON.stringify({ gateId, creativeId }),
  })
  const data = await res.json()
  if (!res.ok) {
    await ctx.answerCbQuery(`❌ ${data.error ?? 'failed'}`)
    return false
  }
  await ctx.answerCbQuery('🔄 রিজেনারেট হয়েছে')
  if (data.summary && data.keyboard) {
    await ctx.editMessageText(`📋 *Ad Creative Gate*\n${data.summary}`, {
      parse_mode: 'Markdown',
      reply_markup: data.keyboard,
    }).catch(() => {
      ctx.reply(`📋 ${data.summary}`, { reply_markup: data.keyboard }).catch(() => {})
    })
  }
  return true
}

export function buildAdsOptimizerKeyboardFromPayload(gateId, payload) {
  const rows = []
  for (let idx = 0; idx < (payload.recommendations ?? []).length; idx++) {
    const r = payload.recommendations[idx]
    if (!r || r.verdict === 'hold') continue
    if ((payload.executedIndices ?? []).includes(idx)) continue
    const icon = r.verdict === 'scale' ? '📈' : r.verdict === 'kill' ? '🛑' : r.verdict === 'duplicate' ? '📋' : r.verdict === 'refresh_creative' ? '🎨' : '📉'
    rows.push([{
      text: `${icon} ${String(r.name ?? r.campaignId).slice(0, 18)}`,
      callback_data: `ads_opt_exec:${gateId}:${idx}`,
    }])
  }
  rows.push([{ text: '⏭ সব skip', callback_data: `reject:${gateId}` }])
  return { inline_keyboard: rows }
}

export async function handleAdsOptimizerExec(ctx, gateId, recIndex) {
  const res = await fetch(`${APP_URL}/api/assistant/internal/ads-optimizer-exec`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${INT_TOKEN}`,
    },
    body: JSON.stringify({ gateId, recIndex: Number(recIndex) }),
  })
  const data = await res.json()
  if (!res.ok) {
    await ctx.answerCbQuery(`❌ ${data.error ?? 'failed'}`)
    return false
  }
  await ctx.answerCbQuery('✅ confirm card পাঠানো')
  await ctx.reply(`📋 ${data.summary ?? 'Confirm card queued'}`, {
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Approve', callback_data: `approve:${data.pendingActionId}` },
        { text: '❌ Cancel', callback_data: `reject:${data.pendingActionId}` },
      ]],
    },
  }).catch(() => {})
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
