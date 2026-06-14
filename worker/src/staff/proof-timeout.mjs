/**
 * Proof timeout — 30 min reminder, 2h unverified flag.
 */
import { notify } from '../notify/index.mjs'
import { loggedSendToStaff } from '../telegram/logged-send.mjs'

const APP_URL = process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = process.env.AGENT_INTERNAL_TOKEN ?? ''
const REMINDER_MS = 30 * 60 * 1000
const TIMEOUT_MS = 2 * 60 * 60 * 1000

async function callTaskCallback(payload) {
  const res = await fetch(`${APP_URL}/api/assistant/internal/task-callback`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${INT_TOKEN}`,
    },
    body: JSON.stringify(payload),
  })
  return res.json()
}

function shortTitle(title) {
  const s = String(title ?? '').trim()
  return s.length > 40 ? `${s.slice(0, 37)}…` : s
}

export async function runProofTimeoutCheck({ supabase, bot }) {
  const { data: tasks } = await supabase
    .from('staff_tasks')
    .select('id, title, staff_id, proof_data, agent_staff(telegram_chat_id, name)')
    .eq('status', 'awaiting_proof')
    .eq('verification_status', 'awaiting_proof')

  if (!tasks?.length) return

  const now = Date.now()

  for (const task of tasks) {
    const proofData = task.proof_data ?? {}
    const requestedAt = proofData.proofRequestedAt
      ? new Date(proofData.proofRequestedAt).getTime()
      : now
    const elapsed = now - requestedAt
    const staffChat = task.agent_staff?.telegram_chat_id
    const label = shortTitle(task.title)

    if (elapsed >= TIMEOUT_MS) {
      const result = await callTaskCallback({ taskId: task.id, action: 'timeout_unverified' })
      await notify({
        tier: 1,
        title: 'টাস্ক প্রমাণ ছাড়াই সম্পন্ন',
        message:
          `⚠️ *${task.agent_staff?.name ?? 'স্টাফ'}* — ${label}\n` +
          `২ ঘণ্টা প্রমাণ পাওয়া যায়নি — done_unverified হিসেবে চিহ্নিত।`,
        category: 'task',
      })
      console.log('[proof-timeout] unverified', task.id, result.taskId)
      continue
    }

    if (elapsed >= REMINDER_MS && !proofData.reminderSentAt && staffChat && bot) {
      const reminderMsg = `📸 ${label} এর প্রমাণ পাঠাননি — ফটো পাঠান`
      await loggedSendToStaff(bot.telegram, {
        supabase,
        staffId: task.staff_id,
        staffName: task.agent_staff?.name ?? 'স্টাফ',
        businessId: 'ALMA_LIFESTYLE',
        type: 'proof_reminder',
        content: reminderMsg,
        chatId: staffChat,
        relatedTaskIds: [task.id],
      }).catch(() => bot.telegram.sendMessage(staffChat, reminderMsg).catch(() => {}))

      await supabase.from('staff_tasks').update({
        proof_data: { ...proofData, reminderSentAt: new Date().toISOString() },
      }).eq('id', task.id)
    }
  }
}
