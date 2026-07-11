/**
 * Todo Reminder Jobs — morning 08:00 + evening 20:30 Asia/Dhaka
 * Seeds agent_todos from the daily duty roster (mirrors live monitor).
 */

import { getAppUrl, getInternalToken } from '../env.mjs'
import { sendMarkdownSafe, escapeMarkdown } from '../telegram/markdown-safe.mjs'
import { getOwnerChatId } from '../telegram/owner-id.mjs'
import { dutiesForToday } from './duties.mjs'

const PRIORITY_EMOJI = { urgent: '🔴', high: '🟡', normal: '🔵', low: '⚪' }

/** Duties shown in monitor but not as owner todos. */
const SKIP_DUTY_TODO = new Set(['salah_init'])

function todayYmdDhaka() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

function todoDueYmd(todo) {
  if (!todo?.dueDate) return null
  return String(todo.dueDate).slice(0, 10)
}

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

/**
 * Idempotent daily seed — one agent_todos row per duty (except salah), source=day_shift.
 * @returns {Promise<{ seeded: number, total: number, skipped?: boolean }>}
 */
export async function seedDailyTodos(supabase) {
  const today = todayYmdDhaka()
  const { getDutyEnabledMap, isDutyEnabledSync } = await import('./duty-enabled.mjs')
  const enabledMap = supabase ? await getDutyEnabledMap(supabase) : {}
  const duties = dutiesForToday()
    .filter((d) => !SKIP_DUTY_TODO.has(d.duty))
    .filter((d) => isDutyEnabledSync(d.duty, enabledMap))
  const url = `${getAppUrl()}/api/assistant/todos`

  const existing = await fetchTodos('?includeCompleted=true')
  if (existing === null) {
    console.warn('[todo-reminder] duty seed skipped: API error')
    return { seeded: 0, total: duties.length, skipped: true }
  }

  const existingKeys = new Set(
    existing
      .filter((t) => t.dutyKey && todoDueYmd(t) === today)
      .map((t) => t.dutyKey),
  )

  let seeded = 0
  for (const d of duties) {
    if (existingKeys.has(d.duty)) continue

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${getInternalToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: d.label,
          priority: 'normal',
          status: 'pending',
          source: 'day_shift',
          dutyKey: d.duty,
          dueDate: today,
          description: d.time ? `⏰ ${d.time} Asia/Dhaka` : null,
        }),
        signal: AbortSignal.timeout(8_000),
      })
      if (res.ok) {
        seeded++
        existingKeys.add(d.duty)
      } else {
        const text = await res.text().catch(() => '')
        console.warn(`[todo-reminder] seed duty ${d.duty} failed: HTTP ${res.status} ${text.slice(0, 120)}`)
      }
    } catch (err) {
      console.warn(`[todo-reminder] seed duty ${d.duty} failed:`, err.message)
    }
  }

  console.log(
    `[todo-reminder] duty seed: ${seeded} new, ${existingKeys.size}/${duties.length} present for ${today}`,
  )
  return { seeded, total: duties.length }
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

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @returns {Promise<Map<string, string>>}
 */
async function fetchDutyStatusesForToday(supabase) {
  const map = new Map()
  if (!supabase) return map
  const today = todayYmdDhaka()
  const { data, error } = await supabase
    .from('agent_duty_log')
    .select('duty, status')
    .eq('duty_date', today)
  if (error) {
    console.warn('[todo-reminder] duty_log read failed:', error.message)
    return map
  }
  for (const row of data ?? []) {
    if (row?.duty) map.set(row.duty, row.status ?? 'pending')
  }
  return map
}

/**
 * Whether a pending duty-todo should be cancelled at end-of-day.
 * @param {object} todo
 * @param {Map<string, string>} dutyStatuses
 */
function shouldCancelStaleDutyTodo(todo, dutyStatuses) {
  if (todo.source === 'owner' || todo.source === 'agent') return false
  // Legacy generic scheduler rows (pre Phase A)
  if (todo.source === 'scheduler') return true
  if (todo.source !== 'day_shift' || !todo.dutyKey) return false

  const ds = dutyStatuses.get(todo.dutyKey)
  // Duty ran — leave todo for Phase B sync (don't blanket-cancel)
  if (ds === 'done' || ds === 'skipped') return false
  // Duty missed/failed or never ran
  if (ds === 'missed' || ds === 'failed' || !ds || ds === 'pending') return true
  return false
}

// ── Morning Reminder (08:00) ─────────────────────────────────────────────────

export async function runMorningTodoReminder(context) {
  const { bot, supabase } = context
  console.log('[todo-reminder] morning check...')

  const seed = await seedDailyTodos(supabase)

  const todos = await fetchTodos('?status=pending,in_progress')

  if (todos === null) {
    return { dutyStatus: 'skipped', dutyDetail: 'API error' }
  }

  if (todos.length === 0) {
    console.log('[todo-reminder] no pending todos — skipping message')
    return { dutyStatus: 'done', dutyDetail: `seed=${seed.seeded}/${seed.total}, no pending` }
  }

  const lines = [
    '🌅 *সুপ্রভাত Boss!* আজকের Agent কাজের তালিকা:',
    '',
    ...todos.map(formatTodoLine),
    '',
    `মোট *${todos.length}টি* কাজ বাকি আছে।`,
  ]

  await sendMarkdownSafe(bot.telegram, getOwnerChatId(), lines.join('\n'))

  console.log(`[todo-reminder] morning: sent ${todos.length} todos`)
  return {
    dutyStatus: 'done',
    dutyDetail: `seed=${seed.seeded}/${seed.total}, reminder=${todos.length}`,
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

export async function runEndOfDayTodoReconcile({ bot, supabase }) {
  console.log('[todo-reminder] end-of-day reconcile...')

  const todos = await fetchTodos('?status=pending,in_progress')
  if (todos === null) {
    return { dutyStatus: 'skipped', dutyDetail: 'API error' }
  }

  const dutyStatuses = await fetchDutyStatusesForToday(supabase)
  const toCancel = todos.filter((t) => shouldCancelStaleDutyTodo(t, dutyStatuses))
  const preserved = todos.filter((t) => !shouldCancelStaleDutyTodo(t, dutyStatuses) && t.source !== 'owner')

  if (preserved.length) {
    console.log(
      `[todo-reminder] reconcile: preserving ${preserved.length} todo(s) (duty ran or owner-managed)`,
    )
  }
  if (toCancel.length === 0) {
    console.log('[todo-reminder] reconcile: nothing to cancel')
    return { dutyStatus: 'done', dutyDetail: `cancelled=0, preserved=${preserved.length}` }
  }

  let cancelled = 0
  for (const t of toCancel) {
    const ok = await patchTodo(t.id, { status: 'cancelled' })
    if (ok) cancelled++
  }

  const lines = [
    '🌃 *দিনশেষ — Agent টাস্ক রিকনসিলিয়েশন*',
    '',
    `আজ যেসব duty চালানো হয়নি, সেগুলো *বাতিল (cancelled)* — মোট ${cancelled}টি:`,
    '',
    ...toCancel.slice(0, 10).map((t) => `  ✕ ${escapeMarkdown(t.title ?? 'Untitled')}`),
    '',
    'কালকে সকালে duty roster থেকে নতুন তালিকা তৈরি হবে, ইনশাআল্লাহ।',
  ]
  await sendMarkdownSafe(bot.telegram, getOwnerChatId(), lines.join('\n'))

  console.log(`[todo-reminder] reconcile: cancelled ${cancelled}/${toCancel.length}`)
  return { dutyStatus: 'done', dutyDetail: `cancelled=${cancelled}` }
}
