/**
 * Daily Focus Planner — AI-powered daily planning for the owner.
 * Runs at 07:45 Dhaka (just after morning briefing at 07:30).
 *
 * Gathers: open todos, pending approvals, scheduled reminders, staff tasks,
 *          yesterday's unresolved items, calendar hints.
 * Returns: a structured, prioritized day plan sent to owner via Telegram.
 */
import Anthropic from '@anthropic-ai/sdk'
import { sendMarkdownSafe } from '../telegram/markdown-safe.mjs'
import { logCost } from '../cost-log.mjs'

const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT = () => process.env.AGENT_INTERNAL_TOKEN ?? ''
const OWNER_CHAT_ID = process.env.TELEGRAM_OWNER_CHAT_ID

async function api(path) {
  try {
    const res = await fetch(`${APP_URL()}${path}`, {
      headers: { Authorization: `Bearer ${INT()}` },
    })
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
    supabase.from('agent_pending_actions').select('summary, type, created_at').eq('status', 'pending').order('created_at').limit(5),
    api('/api/assistant/internal/owner-briefing'),
  ])

  const todos = todosRes?.data ?? []
  const reminders = remindersRes?.data ?? []
  const approvals = approvalsRes?.data ?? []

  const salesInfo = briefing?.sales ? `Yesterday: ৳${briefing.sales.yesterdayTotal}, Orders: ${briefing.sales.yesterdayOrders}` : ''
  const pendingOrders = briefing?.pendingOrders?.count ?? 0

  const contextText = [
    `Today: ${today} (${dayName})`,
    `Open owner todos (${todos.length}):`,
    ...todos.map(t => `  - [${t.priority}] ${t.title}${t.due_hint ? ` (hint: ${t.due_hint})` : ''}`),
    `Reminders today:`,
    ...reminders.filter(r => r.due_at?.startsWith(today)).map(r => `  - ${r.title} at ${r.due_at?.slice(11, 16)}`),
    `Pending approvals: ${approvals.length}`,
    ...approvals.map(a => `  - ${a.summary?.slice(0, 60)}`),
    salesInfo ? `Business: ${salesInfo}. Pending orders: ${pendingOrders}` : '',
  ].filter(Boolean).join('\n')

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: `You are a personal executive assistant for a business owner in Bangladesh. Based on the following context, create a focused daily plan in Bangla. Keep it concise (max 8 items), prioritize by urgency, and group into Morning/Afternoon/Evening. Use bullet points.

CONTEXT:
${contextText}

Reply ONLY with the daily plan in Bangla (no English, no preamble). Format: emoji + time block + items. End with one motivational line.`,
    }],
  })

  const plan = response.content[0]?.type === 'text' ? response.content[0].text : ''
  if (!plan) return { dutyStatus: 'failed', dutyDetail: 'AI returned empty plan' }

  void logCost({
    provider: 'anthropic',
    kind: 'chat',
    units: { inputTokens: response.usage?.input_tokens, outputTokens: response.usage?.output_tokens },
    costUsd: ((response.usage?.input_tokens ?? 0) * 3 + (response.usage?.output_tokens ?? 0) * 15) / 1_000_000,
    dedupKey: `daily-focus:${today}`,
  })

  const msg = `📋 *আজকের ফোকাস প্ল্যান*\n\n${plan}`
  await sendMarkdownSafe(bot.telegram, OWNER_CHAT_ID, msg)

  return { dutyStatus: 'done', dutyDetail: `Plan sent (${todos.length} todos, ${reminders.length} reminders)` }
}
