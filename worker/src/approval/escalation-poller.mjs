/**
 * Escalation poller for unapproved staff messages + duty approval blocks (Phase C).
 * Duty blocks: call at 10 min and 30 min (max 2), then chat/Telegram only.
 */
import { createClient } from '@supabase/supabase-js'
import { getAppUrl, getInternalToken } from '../env.mjs'

function sb() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
}

async function placeTier3Call({ title, message, category }) {
  const res = await fetch(`${getAppUrl()}/api/assistant/internal/urgent-alert`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getInternalToken()}`,
    },
    body: JSON.stringify({
      tier: 3,
      title,
      message,
      voice: true,
      category,
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`urgent-alert HTTP ${res.status}: ${body.slice(0, 100)}`)
  }
}

async function pollStaffMessageEscalations(supabase) {
  const { data: pending } = await supabase
    .from('agent_pending_actions')
    .select('id, payload, summary, createdAt')
    .eq('type', 'staff_auto_message')
    .eq('status', 'pending')
    .order('createdAt', { ascending: true })

  if (!pending?.length) return { pending: 0, callsMade: 0 }

  const now = Date.now()
  let callsMade = 0

  for (const action of pending) {
    const ageMs = now - new Date(action.createdAt).getTime()
    const ageMin = ageMs / 60_000
    const escalationLevel = action.payload?.escalationLevel ?? 0

    let shouldCall = false
    let newLevel = escalationLevel

    if (ageMin >= 30 && escalationLevel < 3) {
      shouldCall = true
      newLevel = 3
    } else if (ageMin >= 20 && escalationLevel < 2) {
      shouldCall = true
      newLevel = 2
    } else if (ageMin >= 10 && escalationLevel < 1) {
      shouldCall = true
      newLevel = 1
    }

    if (shouldCall) {
      const staffName = action.payload?.staffName ?? 'Unknown'
      const type = action.payload?.type ?? 'message'
      const callMessage = `Sir, ${staffName} er jonno ${type} message approve lagbe. Please check your Telegram.`

      try {
        await placeTier3Call({
          title: 'Staff Message Approval Needed',
          message: callMessage,
          category: 'staff_approval_escalation',
        })

        await supabase.from('agent_pending_actions').update({
          payload: {
            ...action.payload,
            escalationLevel: newLevel,
            lastEscalationAt: new Date().toISOString(),
          },
        }).eq('id', action.id).eq('status', 'pending')

        callsMade++
        console.log(`[escalation-poller] staff call #${newLevel} for ${action.id} (${ageMin.toFixed(0)}min)`)
      } catch (err) {
        console.warn('[escalation-poller] staff call failed:', err.message)
      }
    }

    if (ageMin > 30 && escalationLevel >= 3) {
      await supabase.from('agent_pending_actions').update({
        status: 'waiting_list',
        payload: { ...action.payload, escalationLevel: 3, waitingSince: new Date().toISOString() },
      }).eq('id', action.id).eq('status', 'pending')
      console.log(`[escalation-poller] staff action ${action.id} → waiting_list (${ageMin.toFixed(0)}min)`)
    }
  }

  return { pending: pending.length, callsMade }
}

async function pollDutyApprovalEscalations(supabase, bot) {
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID

  const { data: pending } = await supabase
    .from('agent_pending_actions')
    .select('id, payload, summary, createdAt')
    .eq('type', 'duty_approval_block')
    .eq('status', 'pending')
    .order('createdAt', { ascending: true })

  if (!pending?.length) return { pending: 0, callsMade: 0 }

  const now = Date.now()
  let callsMade = 0

  for (const action of pending) {
    const blockedAt = action.payload?.blockedAt ?? action.createdAt
    const ageMin = (now - new Date(blockedAt).getTime()) / 60_000
    const level = action.payload?.escalationLevel ?? 0
    const label = action.payload?.dutyLabel ?? action.summary ?? 'Office duty'

    if (ageMin >= 10 && level < 1) {
      const callMessage =
        `Sir, office duty "${label}" apnar approval chara atke ache. Telegram ba agent chat theke approve korun.`
      try {
        await placeTier3Call({
          title: 'Duty Approval Needed',
          message: callMessage,
          category: 'duty_approval_escalation',
        })
        await supabase.from('agent_pending_actions').update({
          payload: {
            ...action.payload,
            escalationLevel: 1,
            lastEscalationAt: new Date().toISOString(),
          },
        }).eq('id', action.id).eq('status', 'pending')
        callsMade++
        console.log(`[escalation-poller] duty call #1 for ${action.id} (${ageMin.toFixed(0)}min)`)
      } catch (err) {
        console.warn('[escalation-poller] duty call #1 failed:', err.message)
      }
      continue
    }

    if (ageMin >= 30 && level < 2) {
      const callMessage =
        `Sir, abar bolchi — "${label}" ekhono approve hoyni. Doyakore ekhoni approve korun.`
      try {
        await placeTier3Call({
          title: 'Duty Approval — 2nd Reminder',
          message: callMessage,
          category: 'duty_approval_escalation',
        })
        await supabase.from('agent_pending_actions').update({
          payload: {
            ...action.payload,
            escalationLevel: 2,
            lastEscalationAt: new Date().toISOString(),
          },
        }).eq('id', action.id).eq('status', 'pending')
        callsMade++
        console.log(`[escalation-poller] duty call #2 for ${action.id} (${ageMin.toFixed(0)}min)`)
      } catch (err) {
        console.warn('[escalation-poller] duty call #2 failed:', err.message)
      }
      continue
    }

    if (ageMin >= 30 && level >= 2 && !action.payload?.fallbackNotified) {
      const msg = `⏳ Sir, "${label}" এখনো approval-এর অপেক্ষায় — chat/Telegram থেকে approve করলে শেষ করবো।`

      try {
        const res = await fetch(`${getAppUrl()}/api/assistant/internal/urgent-alert`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${getInternalToken()}`,
          },
          body: JSON.stringify({
            tier: 2,
            title: 'Duty approval বাকি',
            message: msg,
            voice: false,
            category: 'duty_approval_fallback',
          }),
          signal: AbortSignal.timeout(30_000),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
      } catch (err) {
        console.warn('[escalation-poller] duty fallback notify failed:', err.message)
      }

      if (ownerChatId && bot) {
        await bot.telegram.sendMessage(ownerChatId, msg).catch((err) => {
          console.warn('[escalation-poller] duty fallback telegram failed:', err.message)
        })
      }

      await supabase.from('agent_pending_actions').update({
        payload: {
          ...action.payload,
          fallbackNotified: true,
          fallbackNotifiedAt: new Date().toISOString(),
        },
      }).eq('id', action.id).eq('status', 'pending')
    }
  }

  return { pending: pending.length, callsMade }
}

export async function pollApprovalEscalations({ bot } = {}) {
  const supabase = sb()

  const staff = await pollStaffMessageEscalations(supabase)
  const duty = await pollDutyApprovalEscalations(supabase, bot)

  const totalPending = staff.pending + duty.pending
  const totalCalls = staff.callsMade + duty.callsMade

  if (totalPending === 0) {
    return { dutyStatus: 'done', dutyDetail: 'No pending approval escalations' }
  }

  return {
    dutyStatus: 'done',
    dutyDetail: `${totalPending} pending, ${totalCalls} calls (staff ${staff.callsMade}, duty ${duty.callsMade})`,
  }
}
