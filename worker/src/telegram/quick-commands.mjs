/**
 * Phase 10 — /today, /khoroch, /ask quick Telegram commands.
 */

import { replyMarkdownSafe } from './markdown-safe.mjs'
import { dhakaTodayYmd, dhakaMidnightUtc, salahDateFilter } from '../salah/dhaka-date.mjs'
import { bnNum } from '../staff/bn-format.mjs'

const APP_URL   = process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = process.env.AGENT_INTERNAL_TOKEN ?? ''

function dhakaToday() {
  return dhakaTodayYmd()
}

function monthStart(today) {
  return today.slice(0, 8) + '01'
}

const WAQT_BN = {
  fajr: 'ফজর', dhuhr: 'যোহর', asr: 'আসর', maghrib: 'মাগরিব', isha: 'ইশা',
}

export async function handleSalahTodayCommand(ctx, supabase) {
  const today = dhakaToday()
  const { data: salahRecords } = await supabase
    .from('salah_records')
    .select('waqt, status')
    .eq('date', salahDateFilter(today))

  if (!salahRecords?.length) {
    await ctx.reply(`🕌 ${today} — এখনো নামাজ রেকর্ড নেই।`)
    return
  }

  const lines = salahRecords.map((r) => {
    const name = WAQT_BN[r.waqt] ?? r.waqt
    const st = r.status === 'prayed_on_time' ? '✅ সময়মতো'
      : r.status === 'prayed_late' ? '⏰ দেরিতে'
      : r.status === 'qaza' ? '🔄 কাযা'
      : r.status === 'missed' ? '❌ মিস'
      : '⏳ বাকি'
    return `• ${name}: ${st}`
  }).join('\n')

  const on = salahRecords.filter((r) => r.status === 'prayed_on_time').length
  await replyMarkdownSafe(ctx, `🕌 *আজকের নামাজ — ${today}*\n${on}/5 সময়মতো\n\n${lines}`)
}

function dhakaTomorrowYmd(today) {
  const d = dhakaMidnightUtc(today)
  d.setDate(d.getDate() + 1)
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

async function fetchActiveTasksForDate(supabase, date) {
  const { data } = await supabase
    .from('staff_tasks')
    .select('status, title, staff_id, agent_staff(name)')
    .eq('proposed_for', date)
    .in('status', ['sent', 'approved', 'done'])
    .order('created_at', { ascending: true })
  return data ?? []
}

function buildStaffTaskSections(tasks) {
  const byStaff = {}
  for (const t of tasks) {
    const staffId = t.staff_id ?? t.agent_staff?.name ?? 'unknown'
    if (!byStaff[staffId]) {
      byStaff[staffId] = { name: t.agent_staff?.name ?? 'অজানা', tasks: [] }
    }
    byStaff[staffId].tasks.push(t)
  }

  const sections = []
  for (const { name, tasks: staffTasks } of Object.values(byStaff)) {
    const doneCount = staffTasks.filter((t) => t.status === 'done').length
    const sorted = [...staffTasks].sort((a, b) => {
      const aDone = a.status === 'done' ? 0 : 1
      const bDone = b.status === 'done' ? 0 : 1
      return aDone - bDone || 0
    })
    const lines = sorted.map((t) => {
      const icon = t.status === 'done' ? '☑️' : '⏳'
      return `${icon} ${t.title}`
    })
    sections.push(`👤 ${name} (${bnNum(doneCount)}/${bnNum(staffTasks.length)}):\n${lines.join('\n')}`)
  }
  return sections.join('\n')
}

function buildSalahLine(salahRecords) {
  const salahOn = salahRecords?.filter((r) => r.status === 'prayed_on_time').length ?? 0
  const salahMiss = salahRecords?.filter((r) => r.status === 'missed').length ?? 0
  const notYet = (salahRecords ?? [])
    .filter((r) => r.status === 'pending' && (r.waqt === 'maghrib' || r.waqt === 'isha'))
    .map((r) => WAQT_BN[r.waqt] ?? r.waqt)
  let line = `🕌 নামাজ: ${bnNum(salahOn)}/৫ সময়মতো`
  if (salahMiss > 0) line += `, ${bnNum(salahMiss)} মিস`
  if (notYet.length > 0) line += ` (${notYet.join(' ও ')} এখনো সময় হয়নি)`
  return line
}

export async function handleTodayCommand(ctx, supabase) {
  const today = dhakaToday()

  const { data: salahRecords } = await supabase
    .from('salah_records')
    .select('waqt, status')
    .eq('date', salahDateFilter(today))

  const salahLine = buildSalahLine(salahRecords)

  let tasks = await fetchActiveTasksForDate(supabase, today)
  if (!tasks.length) {
    tasks = await fetchActiveTasksForDate(supabase, dhakaTomorrowYmd(today))
  }

  const done = tasks.filter((t) => t.status === 'done').length
  const total = tasks.length
  const taskLine = `📋 টাস্ক: ${bnNum(done)}/${bnNum(total)} সম্পন্ন`
  const staffSection = tasks.length ? `\n${buildStaffTaskSections(tasks)}` : ''

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

  const msg =
    `📅 *আজকের স্ন্যাপশট — ${today}*\n` +
    taskLine +
    staffSection +
    `\n${salahLine}` +
    salesLine

  await replyMarkdownSafe(ctx, msg)
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

  await replyMarkdownSafe(ctx, msg)
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
      await replyMarkdownSafe(ctx, `📋 *অনুমোদন প্রয়োজন*\n${card.summary}`, {
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
