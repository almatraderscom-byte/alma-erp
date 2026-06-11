/**
 * Phase 10 — /today, /khoroch, /ask quick Telegram commands.
 */

const APP_URL   = process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = process.env.AGENT_INTERNAL_TOKEN ?? ''

function dhakaToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

function monthStart(today) {
  return today.slice(0, 8) + '01'
}

export async function handleTodayCommand(ctx, supabase) {
  const today = dhakaToday()

  const { data: salahRecords } = await supabase
    .from('salah_records')
    .select('waqt, status')
    .eq('date', today)

  const salahOn = salahRecords?.filter((r) => r.status === 'prayed_on_time').length ?? 0
  const salahMiss = salahRecords?.filter((r) => r.status === 'missed').length ?? 0
  const salahLine = `🕌 নামাজ: ${salahOn}/5 সময়মতো${salahMiss > 0 ? `, ${salahMiss} মিস` : ''}`

  const { data: tasks } = await supabase
    .from('staff_tasks')
    .select('status, title, agent_staff(name)')
    .eq('proposed_for', today)
    .not('status', 'eq', 'cancelled')

  const done = tasks?.filter((t) => t.status === 'done').length ?? 0
  const total = tasks?.length ?? 0
  const taskLine = `📋 টাস্ক: ${done}/${total} সম্পন্ন`

  let salesLine = ''
  try {
    const res = await fetch(`${APP_URL}/api/assistant/internal/agent-settings?keys=today_sales_summary`, {
      headers: { Authorization: `Bearer ${INT_TOKEN}` },
    })
    if (res.ok) {
      const data = await res.json()
      if (data.today_sales_summary) salesLine = `\n📊 ${data.today_sales_summary}`
    }
  } catch { /* non-fatal */ }

  const pending = tasks?.filter((t) => t.status !== 'done').slice(0, 5)
    .map((t) => `  • ${t.agent_staff?.name ?? ''}: ${t.title}`)
    .join('\n') ?? ''

  const msg =
    `📅 *আজকের স্ন্যাপশট — ${today}*\n\n` +
    taskLine + '\n' +
    salahLine +
    salesLine +
    (pending ? `\n\n⏳ বাকি:\n${pending}` : '')

  await ctx.reply(msg, { parse_mode: 'Markdown' })
}

export async function handleKhorochCommand(ctx, supabase) {
  const today = dhakaToday()
  const mStart = monthStart(today)

  const dayStart = new Date(`${today}T00:00:00+06:00`)
  const dayEnd = new Date(`${today}T23:59:59+06:00`)
  const monthStartDt = new Date(`${mStart}T00:00:00+06:00`)

  const { data: todayExp } = await supabase
    .from('finance_expenses')
    .select('amount, currency')
    .gte('occurred_at', dayStart.toISOString())
    .lte('occurred_at', dayEnd.toISOString())

  const { data: monthExp } = await supabase
    .from('finance_expenses')
    .select('amount, currency')
    .gte('occurred_at', monthStartDt.toISOString())
    .lte('occurred_at', dayEnd.toISOString())

  function sumByCurrency(rows) {
    const out = { BDT: 0, AED: 0 }
    for (const r of rows ?? []) {
      const c = r.currency === 'AED' ? 'AED' : 'BDT'
      out[c] += r.amount
    }
    return out
  }

  const t = sumByCurrency(todayExp)
  const m = sumByCurrency(monthExp)

  const fmt = (sums, label) => {
    const parts = []
    if (sums.BDT > 0) parts.push(`৳${sums.BDT.toLocaleString('bn-BD')}`)
    if (sums.AED > 0) parts.push(`AED ${sums.AED.toFixed(2)}`)
    return `${label}: ${parts.length ? parts.join(' + ') : 'শূন্য'}`
  }

  const msg =
    `💸 *খরচ সারাংশ — ${today}*\n\n` +
    fmt(t, 'আজ') + '\n' +
    fmt(m, 'এই মাস')

  await ctx.reply(msg, { parse_mode: 'Markdown' })
}

export async function handleAskCommand(ctx, text, sendToAgent, ownerState) {
  const query = text.replace(/^\/ask\s*/i, '').trim()
  if (!query) {
    await ctx.reply('ব্যবহার: /ask <আপনার প্রশ্ন>')
    return
  }
  await handleOwnerAgentPassthrough(ctx, query, sendToAgent, ownerState)
}

async function handleOwnerAgentPassthrough(ctx, query, sendToAgent, ownerState) {
  try {
    await ctx.sendChatAction('typing')
    const result = await sendToAgent(query, ownerState.conversationId)
    if (result.conversationId) ownerState.conversationId = result.conversationId
    const chunks = splitMessage(result.text || '(কোনো উত্তর নেই)')
    for (const chunk of chunks) {
      await ctx.reply(chunk, { parse_mode: 'Markdown' }).catch(() => ctx.reply(chunk))
    }
    for (const card of result.pendingCards ?? []) {
      await ctx.reply(`📋 *অনুমোদন প্রয়োজন*\n${card.summary}`, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ অনুমোদন', callback_data: `approve:${card.pendingActionId}` },
            { text: '❌ বাতিল', callback_data: `reject:${card.pendingActionId}` },
          ]],
        },
      })
    }
    for (const ask of result.askCards ?? []) {
      await sendAskCardTelegram(ctx, ask)
    }
  } catch (err) {
    await ctx.reply(`❌ সমস্যা: ${err.message}`)
  }
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

export async function sendAskCardTelegram(ctx, ask) {
  const buttons = ask.options.map((opt, i) => [{
    text: opt.slice(0, 60),
    callback_data: `ask_pick:${ask.askCardId}:${i}`,
  }])
  await ctx.reply(`❓ ${ask.question}`, {
    reply_markup: { inline_keyboard: buttons },
  })
}
