/**
 * Todo Reminder Jobs — morning 08:00 + evening 20:30 Asia/Dhaka
 * Fetches agent todos from Vercel API and sends Bangla Telegram summaries.
 */

import { getAppUrl, getInternalToken } from '../env.mjs'
import { sendMarkdownSafe, escapeMarkdown } from '../telegram/markdown-safe.mjs'

import { getOwnerChatId } from '../telegram/owner-id.mjs'

const PRIORITY_EMOJI = { urgent: '🔴', high: '🟡', normal: '🔵', low: '⚪' }

/** @param {{ priority?: string, title?: string }} todo */
function formatTodoLine(todo) {
  const emoji = PRIORITY_EMOJI[todo.priority] ?? '⚪'
  const title = escapeMarkdown(todo.title ?? 'Untitled')
  return `  ${emoji} ${title}`
}

/**
 * Fetch todos from Vercel API with timeout.
 * @param {string} query
 * @returns {Promise<any[]|null>} array of todos, or null on failure
 */
async function fetchTodos(query) {
  const url = `${getAppUrl()}/api/assistant/todos${query}`
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${getInternalToken()}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      console.warn(`[todo-reminder] API ${res.status}: ${url}`)
      return null
    }
    const body = await res.json()
    return Array.isArray(body) ? body : body.todos ?? body.data ?? null
  } catch (err) {
    console.warn(`[todo-reminder] fetch failed: ${err.message}`)
    return null
  }
}

// ── Daily todo seed — ensures there are always tasks for today ───────────────

const DAILY_SEED_TASKS = [
  { title: 'স্টাফ টাস্ক প্রোগ্রেস চেক ও ফলো-আপ', priority: 'high' },
  { title: 'Messenger inbox — unreplied messages রিভিউ', priority: 'high' },
  { title: 'সেলস ডেটা রিভিউ ও অর্ডার ট্র্যাকিং', priority: 'normal' },
  { title: 'ইনভেন্টরি স্ট্যাটাস ও রিঅর্ডার চেক', priority: 'normal' },
  { title: 'কন্টেন্ট/পোস্ট প্ল্যানিং ও শিডিউলিং', priority: 'normal' },
]

async function seedDailyTodos() {
  try {
    const url = `${getAppUrl()}/api/assistant/todos`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${getInternalToken()}` },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return
    const body = await res.json()
    const existing = Array.isArray(body) ? body : body.todos ?? body.data ?? []
    const pendingCount = existing.filter(t => t.status === 'pending' || t.status === 'in_progress').length

    if (pendingCount >= 3) return

    for (const task of DAILY_SEED_TASKS) {
      const already = existing.some(t => t.title?.includes(task.title.slice(0, 15)))
      if (already) continue
      await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getInternalToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: task.title, priority: task.priority, status: 'pending', source: 'scheduler' }),
        signal: AbortSignal.timeout(5_000),
      }).catch(() => {})
    }
    console.log('[todo-reminder] seeded daily tasks')
  } catch (err) {
    console.warn('[todo-reminder] seed failed:', err.message)
  }
}

/**
 * PATCH a single todo's fields via the Vercel API.
 * @param {string} id
 * @param {Record<string, unknown>} patch
 * @returns {Promise<boolean>}
 */
async function patchTodo(id, patch) {
  try {
    const res = await fetch(`${getAppUrl()}/api/assistant/todos`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${getInternalToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...patch }),
      signal: AbortSignal.timeout(8_000),
    })
    return res.ok
  } catch (err) {
    console.warn(`[todo-reminder] patch failed (${id}): ${err.message}`)
    return false
  }
}

// ── Morning Reminder (08:00) ─────────────────────────────────────────────────

export async function runMorningTodoReminder({ bot }) {
  console.log('[todo-reminder] morning check...')

  await seedDailyTodos()

  const todos = await fetchTodos('?status=pending,in_progress')

  if (todos === null) {
    return { dutyStatus: 'skipped', dutyDetail: 'API error' }
  }

  if (todos.length === 0) {
    console.log('[todo-reminder] no pending todos — skipping message')
    return { dutyStatus: 'done', dutyDetail: 'কোনো todo নেই' }
  }

  const lines = [
    '🌅 *সুপ্রভাত Sir!* আজকের Agent কাজের তালিকা:',
    '',
    ...todos.map(formatTodoLine),
    '',
    `মোট *${todos.length}টি* কাজ বাকি আছে।`,
  ]

  await sendMarkdownSafe(bot.telegram, getOwnerChatId(), lines.join('\n'))

  console.log(`[todo-reminder] morning: sent ${todos.length} todos`)
  return {
    dutyStatus: 'done',
    dutyDetail: `${todos.length}টি todo reminder পাঠানো হয়েছে`,
  }
}

// ── Evening Summary (20:30) ──────────────────────────────────────────────────

export async function runEveningTodoSummary({ bot }) {
  console.log('[todo-reminder] evening summary...')

  const todos = await fetchTodos('?includeCompleted=true')

  if (todos === null) {
    return { dutyStatus: 'skipped', dutyDetail: 'API error' }
  }

  const completed = todos.filter(t => t.status === 'completed' || t.status === 'done')
  const pending   = todos.filter(t => t.status !== 'completed' && t.status !== 'done')

  const lines = ['🌙 *আজকের Agent কাজের সারসংক্ষেপ:*', '']

  if (completed.length > 0) {
    lines.push(`✅ *সম্পন্ন: ${completed.length} টি*`)
    completed.forEach(t => lines.push(`  ✓ ${escapeMarkdown(t.title ?? 'Untitled')}`))
    lines.push('')
  }

  if (pending.length > 0) {
    lines.push(`⏳ *বাকি: ${pending.length} টি*`)
    pending.forEach(t => lines.push(formatTodoLine(t)))
    lines.push('')
  }

  if (pending.length === 0 && completed.length > 0) {
    lines.push('🎉 আলহামদুলিল্লাহ! আজকের সব কাজ সম্পন্ন হয়েছে।')
  }

  if (todos.length === 0) {
    lines.push('আজ কোনো কাজ ছিল না।')
  }

  await sendMarkdownSafe(bot.telegram, getOwnerChatId(), lines.join('\n'))

  const detail = `done=${completed.length} pending=${pending.length}`
  console.log(`[todo-reminder] evening: ${detail}`)
  return { dutyStatus: 'done', dutyDetail: detail }
}

// ── End-of-Day Reconcile (23:55) ─────────────────────────────────────────────
// Whatever the agent did NOT finish today is marked `cancelled` so it stays
// visible in the todo list as cancelled (owner confirms the loop is working),
// and the next morning starts with a fresh seeded list. Owner-created tasks are
// left untouched — the owner manages those.

export async function runEndOfDayTodoReconcile({ bot }) {
  console.log('[todo-reminder] end-of-day reconcile...')

  const todos = await fetchTodos('?status=pending,in_progress')
  if (todos === null) {
    return { dutyStatus: 'skipped', dutyDetail: 'API error' }
  }

  const toCancel = todos.filter((t) => t.source !== 'owner')
  if (toCancel.length === 0) {
    console.log('[todo-reminder] reconcile: nothing to cancel')
    return { dutyStatus: 'done', dutyDetail: 'cancelled=0' }
  }

  let cancelled = 0
  for (const t of toCancel) {
    const ok = await patchTodo(t.id, { status: 'cancelled' })
    if (ok) cancelled++
  }

  const lines = [
    '🌃 *দিনশেষ — Agent টাস্ক রিকনসিলিয়েশন*',
    '',
    `আজ যেসব কাজ সম্পন্ন হয়নি, সেগুলো *বাতিল (cancelled)* হিসেবে চিহ্নিত করা হলো — মোট ${cancelled}টি:`,
    '',
    ...toCancel.slice(0, 10).map((t) => `  ✕ ${escapeMarkdown(t.title ?? 'Untitled')}`),
    '',
    'কালকে সকালে নতুন তালিকা তৈরি হবে, ইনশাআল্লাহ।',
  ]
  await sendMarkdownSafe(bot.telegram, getOwnerChatId(), lines.join('\n'))

  console.log(`[todo-reminder] reconcile: cancelled ${cancelled}/${toCancel.length}`)
  return { dutyStatus: 'done', dutyDetail: `cancelled=${cancelled}` }
}
