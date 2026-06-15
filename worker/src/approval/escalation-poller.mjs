/**
 * Escalation poller for unapproved staff messages.
 * At 10/20/30 min, makes escalating phone calls.
 * After 30 min + 3 calls: moves to waiting_list.
 */
import { createClient } from '@supabase/supabase-js'

const APP_URL = process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = process.env.AGENT_INTERNAL_TOKEN ?? ''

function sb() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
}

export async function pollApprovalEscalations() {
  const supabase = sb()

  const { data: pending } = await supabase
    .from('agent_pending_actions')
    .select('id, payload, summary, created_at')
    .eq('type', 'staff_auto_message')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })

  if (!pending?.length) return { dutyStatus: 'done', dutyDetail: 'No pending staff approvals' }

  const now = Date.now()
  let callsMade = 0

  for (const action of pending) {
    const ageMs = now - new Date(action.created_at).getTime()
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
      await supabase.from('agent_pending_actions').update({
        payload: { ...action.payload, escalationLevel: newLevel },
      }).eq('id', action.id)

      const staffName = action.payload?.staffName ?? 'Unknown'
      const type = action.payload?.type ?? 'message'
      const callMessage = `Sir, ${staffName} er jonno ${type} message approve lagbe. Please check your Telegram.`

      try {
        await fetch(`${APP_URL}/api/assistant/internal/urgent-alert`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${INT_TOKEN}`,
          },
          body: JSON.stringify({
            tier: 3,
            title: 'Staff Message Approval Needed',
            message: callMessage,
            voice: true,
            category: 'staff_approval_escalation',
          }),
        })
        callsMade++
        console.log(`[escalation-poller] Call #${newLevel} for action ${action.id} (${ageMin.toFixed(0)}min old)`)
      } catch (err) {
        console.warn('[escalation-poller] call failed:', err.message)
      }
    }

    // After 30 min + 3 calls: move to waiting_list
    if (ageMin > 30 && escalationLevel >= 3) {
      await supabase.from('agent_pending_actions').update({
        status: 'waiting_list',
        payload: { ...action.payload, escalationLevel: 3, waitingSince: new Date().toISOString() },
      }).eq('id', action.id).eq('status', 'pending')
      console.log(`[escalation-poller] Action ${action.id} moved to waiting_list (${ageMin.toFixed(0)}min)`)
    }
  }

  return {
    dutyStatus: 'done',
    dutyDetail: `${pending.length} pending, ${callsMade} calls made`,
  }
}
