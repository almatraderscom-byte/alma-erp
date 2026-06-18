/**
 * Staff progress self-report — a one-tap button so staff can tell the agent/owner
 * where a task stands, instead of only getting a "send a screenshot" message with
 * no way to reply.
 *
 * Flow:
 *   [🔄 Progress জানান] → preset levels → short one-line update to owner + KV record.
 *
 * Owner gets ONE short line (not a big report). The agent can read the latest
 * progress from KV key `staff_progress:${today}:${staffId}`.
 */

import { dhakaToday } from './attendance.mjs'
import { isStaffTaskEnabled } from './staff-toggle.mjs'

const PROGRESS_OPEN = 'task_prog_open'

export const PROGRESS_LEVELS = {
  started: '🟡 শুরু করেছি',
  half: '🟠 অর্ধেক হয়েছে',
  almost: '🟢 প্রায় শেষ',
  stuck: '🔴 আটকে আছি — সাহায্য লাগবে',
}

/** Inline-keyboard row that opens the progress menu. Append to staff messages. */
export function progressButtonRow() {
  return [{ text: '🔄 Progress জানান', callback_data: PROGRESS_OPEN }]
}

/** Reply-markup extra (or null when the owner has switched the button off). */
export async function progressMarkup(supabase) {
  if (supabase && !(await isStaffTaskEnabled(supabase, 'progress_ask'))) return null
  return { reply_markup: { inline_keyboard: [progressButtonRow()] } }
}

export function isProgressOpen(data) {
  return data === PROGRESS_OPEN
}

export function isProgressSelect(data) {
  return typeof data === 'string' && data.startsWith('task_prog:')
}

/** Show the four preset progress levels. */
export async function handleProgressOpen(ctx) {
  const rows = Object.entries(PROGRESS_LEVELS).map(([key, label]) => [
    { text: label, callback_data: `task_prog:${key}` },
  ])
  await ctx.answerCbQuery().catch(() => {})
  await ctx
    .reply('কাজ এখন কোন পর্যায়ে? একটি বেছে নিন 👇', {
      reply_markup: { inline_keyboard: rows },
    })
    .catch(() => {})
}

/**
 * Record a selected progress level and send the owner one short line.
 *
 * @param {import('telegraf').Context} ctx
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} levelKey
 * @param {{ id: string, name?: string }} staff
 */
export async function handleProgressSelect(ctx, supabase, levelKey, staff) {
  const label = PROGRESS_LEVELS[levelKey]
  if (!label) {
    await ctx.answerCbQuery().catch(() => {})
    return
  }

  const today = dhakaToday()
  const staffName = staff?.name || 'স্টাফ'

  await supabase
    .from('agent_kv_settings')
    .upsert({
      key: `staff_progress:${today}:${staff.id}`,
      value: JSON.stringify({ level: levelKey, label, at: new Date().toISOString(), staffName }),
      updated_at: new Date().toISOString(),
    })
    .then(() => {}, () => {})

  await ctx.answerCbQuery('✅ ধন্যবাদ! Boss-কে জানানো হলো।').catch(() => {})

  // Reflect the choice on the message and drop the buttons.
  await ctx
    .editMessageText(`আপডেট পাঠানো হয়েছে: ${label}`, { reply_markup: { inline_keyboard: [] } })
    .catch(() => {})

  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (ownerChatId) {
    await ctx.telegram
      .sendMessage(ownerChatId, `📲 ${staffName}: ${label}`)
      .catch(() => {})
  }
}
