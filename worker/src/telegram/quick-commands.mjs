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

const WAQT_ORDER = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha']

const WAQT_BN = {
  fajr: 'ফজর', dhuhr: 'যোহর', asr: 'আসর', maghrib: 'মাগরিব', isha: 'ইশা',
}

const SECTION_RULE = '━━━━━━━━━━━━━━━━━━━━'
const TELEGRAM_LIMIT = 4096

function formatBanglaDateHeader(ymd) {
  const d = dhakaMidnightUtc(ymd)
  d.setHours(12)
  const formatted = new Intl.DateTimeFormat('bn-BD', {
    timeZone: 'Asia/Dhaka',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    weekday: 'long',
  }).format(d)
  return `📅 ${formatted}`
}

function salahWaqtIcon(status) {
  if (status === 'prayed_on_time') return '✅'
  if (status === 'missed') return '❌'
  if (status === 'prayed_late' || status === 'qaza') return '⏰'
  return '⏳'
}

function buildSalahBlock(salahRecords) {
  const byWaqt = Object.fromEntries((salahRecords ?? []).map((r) => [r.waqt, r.status]))
  const onTime = (salahRecords ?? []).filter((r) => r.status === 'prayed_on_time').length
  const inline = WAQT_ORDER.map((w) => `${WAQT_BN[w]} ${salahWaqtIcon(byWaqt[w] ?? 'pending')}`).join(' | ')
  return `🕌 নামাজ: ${bnNum(onTime)}/৫ ✅\n  ${inline}`
}

function shortenTaskTitle(title) {
  let s = String(title ?? '').trim()
  s = s.replace(/\s*\([^)]*\)/g, '')
  s = s.replace(/\s*[—–-]\s*কল\/মেসেজ.*$/i, '')
  s = s.replace(/\s*(করুন|তৈরি করুন)\s*\.?$/gi, '')
  s = s.replace(/\s+/g, ' ').trim()
  if (s.length > 58) s = `${s.slice(0, 55)}…`
  return s
}

function buildStaffBlocks(tasks) {
  const byStaff = {}
  for (const t of tasks) {
    const staffId = t.staff_id ?? 'unknown'
    if (!byStaff[staffId]) {
      byStaff[staffId] = { name: t.agent_staff?.name ?? 'অজানা', tasks: [] }
    }
    byStaff[staffId].tasks.push(t)
  }

  const blocks = []
  for (const { name, tasks: staffTasks } of Object.values(byStaff)) {
    const doneCount = staffTasks.filter((t) => t.status === 'done').length
    const allDone = doneCount === staffTasks.length && staffTasks.length > 0
    const header = `👤 ${name} — ${bnNum(doneCount)}/${bnNum(staffTasks.length)}${allDone ? ' ✅' : ''}`
    const sorted = [...staffTasks].sort((a, b) => {
      const aDone = a.status === 'done' ? 0 : 1
      const bDone = b.status === 'done' ? 0 : 1
      return aDone - bDone
    })
    const lines = sorted.map((t) => {
      const icon = t.status === 'done' ? '✅' : '⏳'
      return `  ${icon} ${shortenTaskTitle(t.title)}`
    })
    blocks.push([header, ...lines].join('\n'))
  }
  return blocks.join('\n\n')
}

function formatUsdBn(amount) {
  const n = Number(amount) || 0
  const [whole, frac] = n.toFixed(2).split('.')
  return `$${bnNum(whole)}.${bnNum(frac)}`
}

async function fetchTodayAiCost(supabase, today) {
  const dayStart = `${today}T00:00:00+06:00`
  const dayEnd = `${today}T23:59:59.999+06:00`
  const { data, error } = await supabase
    .from('agent_cost_events')
    .select('cost_usd')
    .gte('occurred_at', dayStart)
    .lte('occurred_at', dayEnd)
  if (error || !data?.length) return 0
  return data.reduce((sum, row) => sum + Number(row.cost_usd ?? 0), 0)
}

function splitTodayMessage(text) {
  if (text.length <= TELEGRAM_LIMIT) return [text]
  const parts = text.split(`\n${SECTION_RULE}\n`)
  if (parts.length < 2) {
    return [text.slice(0, TELEGRAM_LIMIT - 1), text.slice(TELEGRAM_LIMIT - 1)]
  }
  const chunks = []
  let current = parts[0]
  for (let i = 1; i < parts.length; i++) {
    const segment = `${SECTION_RULE}\n${parts[i]}`
    const candidate = current ? `${current}\n${segment}` : segment
    if (candidate.length > TELEGRAM_LIMIT) {
      if (current) chunks.push(current)
      current = segment
    } else {
      current = candidate
    }
  }
  if (current) chunks.push(current)
  return chunks.length ? chunks : [text.slice(0, TELEGRAM_LIMIT)]
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

export async function handleTodayCommand(ctx, supabase) {
  const today = dhakaToday()

  const [{ data: salahRecords }, aiCost] = await Promise.all([
    supabase
      .from('salah_records')
      .select('waqt, status')
      .eq('date', salahDateFilter(today)),
    fetchTodayAiCost(supabase, today),
  ])

  let tasks = await fetchActiveTasksForDate(supabase, today)
  if (!tasks.length) {
    tasks = await fetchActiveTasksForDate(supabase, dhakaTomorrowYmd(today))
  }

  const done = tasks.filter((t) => t.status === 'done').length
  const total = tasks.length

  const sections = [
    formatBanglaDateHeader(today),
    '',
    buildSalahBlock(salahRecords),
    '',
    SECTION_RULE,
    '',
    `📋 টাস্ক: ${bnNum(done)}/${bnNum(total)} সম্পন্ন`,
    '',
    tasks.length ? buildStaffBlocks(tasks) : '  কোনো active টাস্ক নেই',
    '',
    SECTION_RULE,
    '',
    `💰 আজকের AI খরচ: ${formatUsdBn(aiCost)}`,
  ]

  const msg = sections.join('\n')
  const chunks = splitTodayMessage(msg)
  for (const chunk of chunks) {
    await ctx.reply(chunk)
  }
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

async function fetchApiBalanceSummary(supabase) {
  try {
    const { data } = await supabase
      .from('agent_kv_settings')
      .select('value')
      .eq('key', 'api_balance_cache')
      .maybeSingle()
    if (!data?.value) return ''
    const cache = JSON.parse(data.value)
    if (cache?.summaryLine) return `\n${cache.summaryLine}`
  } catch { /* non-fatal */ }
  return ''
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
  const balanceLine = await fetchApiBalanceSummary(supabase)

  const fmt = (sums, label) => {
    const parts = []
    if (sums.BDT > 0) parts.push(`৳${sums.BDT.toLocaleString('bn-BD')}`)
    if (sums.AED > 0) parts.push(`AED ${sums.AED.toFixed(2)}`)
    return `${label}: ${parts.length ? parts.join(' + ') : 'শূন্য'}`
  }

  const msg =
    `💸 *খরচ সারাংশ — ${today}*\n\n` +
    fmt(t, 'আজ') + '\n' +
    fmt(m, 'এই মাস') +
    balanceLine

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
