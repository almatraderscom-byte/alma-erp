/**
 * Daily Focus Planner — AI-powered daily planning for the owner.
 * Runs at 07:45 Dhaka (just after morning briefing at 07:30).
 *
 * Gathers: open todos, pending approvals, scheduled reminders.
 * Sends structured data to Vercel API which generates AI-powered plan.
 */
import { sendMarkdownSafe } from '../telegram/markdown-safe.mjs'

const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT = () => process.env.AGENT_INTERNAL_TOKEN ?? ''
const OWNER_CHAT_ID = process.env.TELEGRAM_OWNER_CHAT_ID

async function api(path, method = 'GET', body = null) {
  try {
    const opts = {
      method,
      headers: { Authorization: `Bearer ${INT()}`, 'Content-Type': 'application/json' },
    }
    if (body) opts.body = JSON.stringify(body)
    const res = await fetch(`${APP_URL()}${path}`, opts)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

function dhakaToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

function dhakaDay() {
  return new Date().toLocaleDateString('bn-BD', { timeZone: 'Asia/Dhaka', weekday: 'long' })
}

export async function runDailyFocus(context) {
  const { supabase, bot } = context
  if (!OWNER_CHAT_ID || !bot) return { dutyStatus: 'skipped', dutyDetail: 'no owner chat' }

  const today = dhakaToday()
  const dayName = dhakaDay()

  const [todosRes, remindersRes, approvalsRes, briefing] = await Promise.all([
    supabase.from('agent_owner_todos').select('title, priority, due_hint, created_at').eq('status', 'open').order('priority', { ascending: false }).limit(15),
    supabase.from('agent_reminders').select('title, due_at, tier').eq('status', 'pending').gte('due_at', new Date().toISOString()).order('due_at').limit(10),
    supabase.from('agent_pending_actions').select('summary, type, createdAt').eq('status', 'pending').order('createdAt').limit(5),
    api('/api/assistant/internal/owner-briefing'),
  ])

  const todos = todosRes?.data ?? []
  const reminders = remindersRes?.data ?? []
  const approvals = approvalsRes?.data ?? []

  const salesInfo = briefing?.sales ? `Yesterday: ৳${briefing.sales.yesterdayTotal}, Orders: ${briefing.sales.yesterdayOrders}` : ''
  const pendingOrders = briefing?.pendingOrders?.count ?? 0

  const contextLines = [
    `Today: ${today} (${dayName})`,
    `Open owner todos (${todos.length}):`,
    ...todos.map(t => `  - [${t.priority}] ${t.title}${t.due_hint ? ` (hint: ${t.due_hint})` : ''}`),
    `Reminders today:`,
    ...reminders.filter(r => r.due_at?.startsWith(today)).map(r => `  - ${r.title} at ${r.due_at?.slice(11, 16)}`),
    `Pending approvals: ${approvals.length}`,
    ...approvals.map(a => `  - ${a.summary?.slice(0, 60)}`),
    salesInfo ? `Business: ${salesInfo}. Pending orders: ${pendingOrders}` : '',
  ].filter(Boolean)

  const planResult = await api('/api/assistant/internal/generate-focus-plan', 'POST', {
    context: contextLines.join('\n'),
    today,
    dayName,
  })

  if (!planResult?.plan) {
    const fallbackPlan = buildFallbackPlan(todos, reminders, approvals, dayName)
    await sendMarkdownSafe(bot.telegram, OWNER_CHAT_ID, `📋 *আজকের ফোকাস প্ল্যান*\n\n${fallbackPlan}`)
    return { dutyStatus: 'done', dutyDetail: `Fallback plan sent (no AI)` }
  }

  const msg = `📋 *আজকের ফোকাস প্ল্যান*\n\n${planResult.plan}`
  await sendMarkdownSafe(bot.telegram, OWNER_CHAT_ID, msg)

  return { dutyStatus: 'done', dutyDetail: `Plan sent (${todos.length} todos, ${reminders.length} reminders)` }
}

function buildFallbackPlan(todos, reminders, approvals, dayName) {
  const L = [`🗓️ ${dayName}`, '']
  if (approvals.length) {
    L.push('🔴 *জরুরি (Approval):*')
    approvals.forEach(a => L.push(`  • ${a.summary?.slice(0, 50)}`))
    L.push('')
  }
  const high = todos.filter(t => t.priority === 'high')
  if (high.length) {
    L.push('⚡ *গুরুত্বপূর্ণ:*')
    high.forEach(t => L.push(`  • ${t.title}`))
    L.push('')
  }
  const normal = todos.filter(t => t.priority !== 'high').slice(0, 5)
  if (normal.length) {
    L.push('📌 *টুডু:*')
    normal.forEach(t => L.push(`  • ${t.title}`))
  }
  if (reminders.length) {
    L.push('')
    L.push('⏰ *রিমাইন্ডার:*')
    reminders.slice(0, 3).forEach(r => L.push(`  • ${r.title}`))
  }
  return L.join('\n')
}
