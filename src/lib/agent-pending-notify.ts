/**
 * Bridge: surface a newly-created agent pending action (agent_pending_actions)
 * in the ERP notification bell + push, so agent approvals behave "like ERP
 * approvals" — owner directive 2026-06-25.
 *
 * This is ERP→ERP only: it reacts to a Prisma model write and calls the shared
 * createNotification. It does NOT import from src/agent (one-way dependency rule);
 * AgentPendingAction is a database table, not agent code. Invoked fire-and-forget
 * from the Prisma client extension in src/lib/prisma.ts — it must never throw.
 */
import { createNotification } from '@/lib/notifications'
import { logEvent } from '@/lib/logger'

type CreatedAgentAction = {
  id: string
  type: string
  status: string
  summary: string | null
  businessId?: string | null
}

/** Short, owner-friendly labels (mirror of AgentApprovalsTab TYPE_LABELS). */
const TYPE_LABELS: Record<string, string> = {
  agent_voice_call: 'Voice call (two-way)',
  outbound_call: 'Voice call (one-way)',
  dispatch_staff_tasks: 'স্টাফ টাস্ক ডিসপ্যাচ',
}

function label(type: string): string {
  return TYPE_LABELS[type] ?? type.replace(/_/g, ' ')
}

/**
 * Fire-and-forget. Only real, owner-facing approval items (status 'pending')
 * generate a bell entry — executed/auto-approved/audit rows are skipped so the
 * owner is never nagged about things that needed no decision.
 */
export async function notifyAgentPendingCreated(action: CreatedAgentAction): Promise<void> {
  try {
    if (!action || action.status !== 'pending') return

    const summary = (action.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
    await createNotification({
      role: 'SUPER_ADMIN',
      businessId: action.businessId ?? null,
      type: 'ADMIN_ANNOUNCEMENT',
      priority: 'NORMAL',
      title: 'এজেন্ট অনুমোদন প্রয়োজন',
      message: summary || `${label(action.type)} অনুমোদনের অপেক্ষায়।`,
      actionUrl: '/approvals',
      metadata: {
        source: 'agent_pending_action',
        agentActionId: action.id,
        type: action.type,
      },
    })
  } catch (err) {
    logEvent('warn', 'agent_pending.notify.failed', {
      message: err instanceof Error ? err.message : String(err),
    })
  }
}
