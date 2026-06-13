/**
 * Progressive owner notification when staff marks tasks Done.
 * Updates a single Telegram message per staff per day (editMessageText).
 */
import { sendMarkdownSafe } from '../telegram/markdown-safe.mjs'
import { bnNum } from './bn-format.mjs'

function progressKvKey(staffId, date) {
  return `staff_task_progress:${staffId}:${date}`
}

async function getStoredMessageId(supabase, staffId, date) {
  const { data } = await supabase
    .from('agent_kv_settings')
    .select('value')
    .eq('key', progressKvKey(staffId, date))
    .maybeSingle()
  return data?.value?.messageId ?? null
}

async function storeMessageId(supabase, staffId, date, messageId) {
  await supabase.from('agent_kv_settings').upsert({
    key: progressKvKey(staffId, date),
    value: { messageId },
    updated_at: new Date().toISOString(),
  })
}

export function buildProgressiveSummary(staffName, tasks) {
  const active = tasks.filter((t) => t.status !== 'cancelled')
  const total = active.length
  const done = active.filter((t) => t.status === 'done')
  const pending = active.filter((t) => t.status !== 'done')
  const doneCount = done.length

  const iconFor = (t) => {
    if (t.status === 'done') return '☑️'
    if (t.status === 'awaiting_proof' || ['proof_submitted', 'auto_verified'].includes(t.verification_status ?? t.verificationStatus)) return '🔍'
    if (t.verification_status === 'redo_requested' || t.verificationStatus === 'redo_requested') return '🔄'
    return '⏳'
  }

  const doneLines = done.map((t, i) => `☑️ ${i + 1}. ${t.title}`).join('\n')
  const pendingLines = pending.map((t, i) => `${iconFor(t)} ${doneCount + i + 1}. ${t.title}`).join('\n')

  let msg = `✅ *${staffName}* — ${bnNum(total)} এর মধ্যে ${bnNum(doneCount)} সম্পন্ন`
  if (doneCount > 0) {
    msg += `\n\nসম্পন্ন:\n${doneLines}`
  }
  if (pending.length > 0) {
    msg += `\n\nবাকি ${bnNum(pending.length)}টি:\n${pendingLines}`
  }
  return msg
}

export async function sendOrUpdateTaskProgress(telegram, supabase, ownerChatId, staffId, staffName, tasks, date) {
  if (!ownerChatId || !tasks?.length) return

  const text = buildProgressiveSummary(staffName, tasks)
  const storedId = await getStoredMessageId(supabase, staffId, date)

  if (storedId) {
    try {
      await telegram.editMessageText(ownerChatId, storedId, undefined, text, { parse_mode: 'Markdown' })
      return
    } catch (err) {
      const msg = String(err?.message ?? '')
      if (/parse entities|can't find end of the entity/i.test(msg)) {
        try {
          await telegram.editMessageText(ownerChatId, storedId, undefined, text)
          return
        } catch { /* fall through to new message */ }
      } else if (!/message to edit not found|message can't be edited/i.test(msg)) {
        console.warn('[task-progress] edit failed:', msg)
      }
    }
  }

  const sent = await sendMarkdownSafe(telegram, ownerChatId, text)
  const messageId = sent?.message_id
  if (messageId) {
    await storeMessageId(supabase, staffId, date, messageId)
  }
}
