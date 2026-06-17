/**
 * Proof timeout — staff nudge ×2, then owner escalation (Phase 3).
 */
import { getAppUrl, getInternalToken } from '../env.mjs'
import { loggedSendToStaff } from '../telegram/logged-send.mjs'
import { isWithinOfficeHours } from './office-hours.mjs'
import {
  NUDGE1_MS,
  NUDGE2_MS,
  ESCALATE_MS,
  MAX_STAFF_NUDGES,
  getTaskNudgeCount,
  staffTaskNudgeMessage,
  staffProofNudgeMessage,
  formatOwnerEscalation,
  sendOwnerEscalation,
} from './task-nudge.mjs'

async function callTaskCallback(payload, attempt = 0) {
  const base = getAppUrl()
  if (!base) throw new Error('[proof-timeout] APP_URL is not configured')
  try {
    const res = await fetch(`${base}/api/assistant/internal/task-callback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getInternalToken()}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
    }
    return res.json()
  } catch (err) {
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
      return callTaskCallback(payload, attempt + 1)
    }
    throw err
  }
}

function anchorTime(task) {
  const pd = task.proof_data ?? {}
  if (pd.proofRequestedAt) return new Date(pd.proofRequestedAt).getTime()
  if (pd.sentAt) return new Date(pd.sentAt).getTime()
  if (task.created_at) return new Date(task.created_at).getTime()
  return Date.now()
}

async function sendStaffNudge({ bot, supabase, task, message }) {
  const staffChat = task.agent_staff?.telegramChatId
  if (!staffChat || !bot) return false
  await loggedSendToStaff(bot.telegram, {
    supabase,
    staffId: task.staff_id,
    staffName: task.agent_staff?.name ?? 'স্টাফ',
    businessId: task.business_id ?? 'ALMA_LIFESTYLE',
    type: 'task_nudge',
    content: message,
    chatId: staffChat,
    relatedTaskIds: [task.id],
    requiresAck: false,
    extra: { skipApproval: true },
  }).catch((err) => {
    console.warn(`[proof-timeout] nudge send failed ${task.id}:`, err.message)
    return bot.telegram.sendMessage(staffChat, message).catch(() => {})
  })
  return true
}

export async function runProofTimeoutCheck({ supabase, bot }) {
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  const duringOffice = isWithinOfficeHours('ALMA_LIFESTYLE')

  const { data: tasks } = await supabase
    .from('staff_tasks')
    .select('id, title, staff_id, status, verification_status, proof_data, business_id, created_at, agent_staff(telegramChatId, name)')
    .in('status', ['awaiting_proof', 'sent'])
    .neq('type', 'learning')

  if (!tasks?.length) return { nudged: 0, escalated: 0 }

  const now = Date.now()
  let nudged = 0
  let escalated = 0

  for (const task of tasks) {
    const proofData = task.proof_data ?? {}
    if (proofData.ownerEscalatedAt) continue

    if (task.status === 'sent' && !['not_required', 'redo_requested', 'awaiting_proof'].includes(task.verification_status ?? 'not_required')) {
      continue
    }

    const elapsed = now - anchorTime(task)
    const nudgeCount = getTaskNudgeCount(proofData)
    const staffName = task.agent_staff?.name ?? 'স্টাফ'
    const isProofWait = task.status === 'awaiting_proof'
    const nudgeMsg = isProofWait ? staffProofNudgeMessage(task.title) : staffTaskNudgeMessage(task.title)

    if (elapsed >= ESCALATE_MS && nudgeCount >= MAX_STAFF_NUDGES) {
      if (isProofWait) {
        await callTaskCallback({ taskId: task.id, action: 'timeout_unverified' }).catch((err) => {
          console.warn('[proof-timeout] timeout_unverified failed:', err.message)
        })
      }
      const reason = isProofWait
        ? '২টা reminder + প্রমাণ পাওয়া যায়নি'
        : '২টা reminder — কাজ শেষ হয়নি'
      const line = formatOwnerEscalation({
        staffName,
        title: task.title,
        reason,
        recommendation: 'Telegram এ directly জিজ্ঞেস করুন বা কাল সকালে follow-up।',
      })
      const sent = await sendOwnerEscalation(bot?.telegram, ownerChatId, line)
      if (sent) {
        await supabase.from('staff_tasks').update({
          proof_data: {
            ...proofData,
            ownerEscalatedAt: new Date().toISOString(),
            nudgeCount,
          },
        }).eq('id', task.id)
        escalated++
      }
      continue
    }

    if (!duringOffice) continue

    const dueNudge =
      (elapsed >= NUDGE1_MS && nudgeCount < 1) ||
      (elapsed >= NUDGE2_MS && nudgeCount < 2)

    if (!dueNudge || nudgeCount >= MAX_STAFF_NUDGES) continue

    const sent = await sendStaffNudge({ bot, supabase, task, message: nudgeMsg })
    if (!sent) continue

    await supabase.from('staff_tasks').update({
      proof_data: {
        ...proofData,
        nudgeCount: nudgeCount + 1,
        lastNudgeAt: new Date().toISOString(),
        ...(nudgeCount === 0 && !proofData.reminderSentAt ? { reminderSentAt: new Date().toISOString() } : {}),
      },
    }).eq('id', task.id)
    nudged++
    console.log(`[proof-timeout] nudge ${nudgeCount + 1} → ${staffName} task=${task.id}`)
  }

  return { nudged, escalated }
}
