/**
 * Finance confirm card keyboards + Telegram callback handlers.
 */

const FIELD_LABELS = {
  amount: '💰 পরিমাণ',
  personName: '👤 নাম',
  category: '📂 ক্যাটাগরি',
  direction: '↔️ দিক',
  currency: '💱 মুদ্রা',
  note: '📝 নোট',
}

export function buildFinanceKeyboard(card) {
  const rows = []
  if (card.isBatch && card.entryCount > 0) {
    for (let i = 0; i < card.entryCount; i++) {
      rows.push([{ text: `🗑️ ${i + 1}`, callback_data: `fin_rm:${card.pendingActionId}:${i}` }])
    }
  }
  rows.push([
    { text: card.isBatch ? '✅ সব Approve' : '✅ অনুমোদন', callback_data: `approve:${card.pendingActionId}` },
    { text: '✏️ সংশোধন', callback_data: `fin_edit:${card.pendingActionId}` },
    { text: '❌ বাতিল', callback_data: `reject:${card.pendingActionId}` },
  ])
  return rows
}

export async function fetchActionMeta(appUrl, token, actionId) {
  const res = await fetch(`${appUrl}/api/assistant/actions/${actionId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return null
  return res.json()
}

export async function patchFinanceAction(appUrl, token, actionId, body) {
  const res = await fetch(`${appUrl}/api/assistant/actions/${actionId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

export function buildEditFieldKeyboard(actionId, fields) {
  const usable = (fields ?? []).filter((f) => FIELD_LABELS[f])
  const rows = []
  for (let i = 0; i < usable.length; i += 2) {
    const row = usable.slice(i, i + 2).map((f) => ({
      text: FIELD_LABELS[f],
      callback_data: `fin_edit_f:${actionId}:${f}`,
    }))
    rows.push(row)
  }
  rows.push([{ text: '🗑️ বাতিল', callback_data: `fin_edit_cancel:${actionId}` }])
  return rows
}

export async function handleFinanceRemove(ctx, appUrl, token, actionId, index) {
  const updated = await patchFinanceAction(appUrl, token, actionId, { removeEntryIndex: index })
  await ctx.answerCbQuery(`#${index + 1} সরানো হয়েছে`)
  const card = {
    pendingActionId: actionId,
    summary: updated.summary,
    isBatch: updated.isBatch,
    entryCount: updated.entryCount,
    isFinance: true,
  }
  await ctx.editMessageText(`📋 *অনুমোদন প্রয়োজন*\n${updated.summary}`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buildFinanceKeyboard(card) },
  }).catch(async () => {
    await ctx.reply(`📋 আপডেট:\n${updated.summary}`, {
      reply_markup: { inline_keyboard: buildFinanceKeyboard(card) },
    })
  })
}

export async function handleFinanceEditMenu(ctx, appUrl, token, actionId, ownerState) {
  const meta = await fetchActionMeta(appUrl, token, actionId)
  if (!meta?.isFinance) {
    await ctx.answerCbQuery('সম্পাদনা উপলব্ধ নয়')
    return
  }
  if (meta.isBatch && meta.entryCount > 1) {
    await ctx.answerCbQuery('✏️')
    await ctx.reply('ব্যাচে আলাদা আইটেম সংশোধন: 🗑️ দিয়ে সরান, অথবা বাতিল করে আবার লিখুন। একক এন্ট্রিতে ✏️ সংশোধন কাজ করবে।')
    return
  }
  const fields = meta.editFields ?? []
  if (!fields.length) {
    await ctx.answerCbQuery('কোনো ফিল্ড নেই')
    return
  }
  await ctx.answerCbQuery('কী বদলাবেন?')
  await ctx.reply('কী বদলাবেন?', {
    reply_markup: { inline_keyboard: buildEditFieldKeyboard(actionId, fields) },
  })
}

export async function handleFinanceEditField(ctx, actionId, field, ownerState) {
  ownerState.financeEdit = { actionId, field }
  const label = FIELD_LABELS[field] ?? field
  await ctx.answerCbQuery(label)
  await ctx.reply(`${label} — নতুন মান লিখে পাঠান:`)
}

export async function handleFinanceEditValue(ctx, appUrl, token, ownerState, text) {
  const pending = ownerState.financeEdit
  if (!pending) return false
  ownerState.financeEdit = null

  const updated = await patchFinanceAction(appUrl, token, pending.actionId, {
    field: pending.field,
    value: text.trim(),
  })

  const card = {
    pendingActionId: pending.actionId,
    summary: updated.summary,
    isBatch: updated.isBatch,
    entryCount: updated.entryCount,
    isFinance: true,
  }
  await ctx.reply(`📋 *সংশোধিত কার্ড*\n${updated.summary}`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buildFinanceKeyboard(card) },
  })
  return true
}
