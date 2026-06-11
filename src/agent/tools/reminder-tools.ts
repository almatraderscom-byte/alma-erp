/**
 * Phase 9 — Personal reminders + urgent alerts.
 */
import { prisma } from '@/lib/prisma'
import { formatReminderConfirmation } from '@/agent/lib/reminder-rrule'
import { checkUrgentRateLimit } from '@/agent/lib/urgent-rate-limit'
import type { AgentTool } from './registry'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const APP_URL = () => (process.env.APP_URL ?? '').replace(/\/$/, '')
const INT_TOKEN = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

async function dispatchUrgentNow(payload: { tier: number; title: string; message: string; voice?: boolean }) {
  const base = APP_URL()
  if (!base || !INT_TOKEN()) {
    return { ok: false, error: 'APP_URL or AGENT_INTERNAL_TOKEN not configured' }
  }
  const res = await fetch(`${base}/api/assistant/internal/urgent-alert`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${INT_TOKEN()}`,
    },
    body: JSON.stringify(payload),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` }
  return { ok: true, data }
}

const set_reminder: AgentTool = {
  name: 'set_reminder',
  description:
    'Sets a personal reminder at a future time (Asia/Dhaka). Resolve natural language to ISO dueAt before calling. ' +
    'tier 1=normal, 2=critical ntfy, 3=phone call. tier 3 requires owner confirm card. Never claim reminder is set without this tool.',
  input_schema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string' },
      body: { type: 'string' },
      dueAt: { type: 'string', description: 'ISO 8601 datetime (future)' },
      recurrenceRrule: { type: 'string', description: 'e.g. FREQ=DAILY' },
      tier: { type: 'number', description: '1, 2, or 3 (default 1)' },
      voice: { type: 'boolean' },
      conversationId: { type: 'string' },
    },
    required: ['title', 'dueAt'],
  },
  handler: async (input) => {
    try {
      const title = String(input.title).trim()
      const dueAt = new Date(String(input.dueAt))
      if (!title || Number.isNaN(dueAt.getTime())) {
        return { success: false, error: 'title and valid dueAt required' }
      }
      if (dueAt.getTime() <= Date.now()) {
        return { success: false, error: 'dueAt must be in the future' }
      }

      const tier = Math.min(3, Math.max(1, Number(input.tier ?? 1)))
      const voice = input.voice !== false

      if (tier === 3) {
        const action = await db.agentPendingAction.create({
          data: {
            conversationId: input.conversationId ? String(input.conversationId) : null,
            type: 'set_reminder_tier3',
            payload: {
              title,
              body: input.body ? String(input.body) : null,
              dueAt: dueAt.toISOString(),
              recurrenceRrule: input.recurrenceRrule ? String(input.recurrenceRrule) : null,
              tier,
              voice,
            },
            summary: `📞 Tier-3 রিমাইন্ডার (কল): ${title}\nসময়: ${dueAt.toLocaleString('bn-BD', { timeZone: 'Asia/Dhaka' })}`,
            costEstimate: 0.05,
            status: 'pending',
          },
        })
        return {
          success: true,
          data: {
            pendingActionId: action.id,
            message: 'Tier-3 reminder needs Approve (phone call at due time).',
          },
        }
      }

      const reminder = await db.agentReminder.create({
        data: {
          title,
          body: input.body ? String(input.body) : null,
          dueAt,
          recurrenceRrule: input.recurrenceRrule ? String(input.recurrenceRrule) : null,
          tier,
          voice,
          status: 'pending',
          sourceConversationId: input.conversationId ? String(input.conversationId) : null,
        },
      })

      return {
        success: true,
        data: {
          id: reminder.id,
          confirmation: formatReminderConfirmation(title, dueAt),
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const list_reminders: AgentTool = {
  name: 'list_reminders',
  description: 'Lists personal reminders, optionally filtered by status.',
  input_schema: {
    type: 'object' as const,
    properties: {
      status: { type: 'string', description: 'pending,sent,snoozed,done,cancelled (comma-separated)' },
    },
  },
  handler: async (input) => {
    try {
      const where: Record<string, unknown> = {}
      if (input.status) {
        where.status = { in: String(input.status).split(',').map((s) => s.trim()) }
      } else {
        where.status = { in: ['pending', 'sent', 'snoozed'] }
      }
      const rows = await db.agentReminder.findMany({
        where,
        orderBy: { dueAt: 'asc' },
        take: 30,
      })
      return { success: true, data: rows }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const cancel_reminder: AgentTool = {
  name: 'cancel_reminder',
  description: 'Cancels a reminder by id.',
  input_schema: {
    type: 'object' as const,
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
  handler: async (input) => {
    try {
      const updated = await db.agentReminder.update({
        where: { id: String(input.id) },
        data: { status: 'cancelled' },
      })
      return { success: true, data: updated }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const snooze_reminder: AgentTool = {
  name: 'snooze_reminder',
  description: 'Snoozes a reminder for N minutes.',
  input_schema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string' },
      minutes: { type: 'number', description: 'Default 30' },
    },
    required: ['id'],
  },
  handler: async (input) => {
    try {
      const minutes = Math.max(1, Number(input.minutes ?? 30))
      const snoozedUntil = new Date(Date.now() + minutes * 60_000)
      const updated = await db.agentReminder.update({
        where: { id: String(input.id) },
        data: { status: 'snoozed', snoozedUntil },
      })
      return { success: true, data: updated }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const send_urgent_alert: AgentTool = {
  name: 'send_urgent_alert',
  description:
    'Sends an immediate urgent alert via notify (ntfy + Telegram + optional voice/call). ' +
    'tier 2=critical ntfy (5/hour limit). tier 3=phone call — requires confirm card (2/day limit). ' +
    'Use when Sir says urgent/জরুরি or explicitly asks for a call.',
  input_schema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string' },
      message: { type: 'string' },
      tier: { type: 'number', enum: [2, 3] },
      voice: { type: 'boolean' },
      conversationId: { type: 'string' },
    },
    required: ['title', 'message', 'tier'],
  },
  handler: async (input) => {
    try {
      const tier = Number(input.tier) === 3 ? 3 : 2
      const title = String(input.title).trim()
      const message = String(input.message).trim()
      if (!title || !message) return { success: false, error: 'title and message required' }

      const rate = await checkUrgentRateLimit(tier as 2 | 3)
      if (!rate.ok) return { success: false, error: rate.error }

      const voice = input.voice !== false

      if (tier === 3) {
        const action = await db.agentPendingAction.create({
          data: {
            conversationId: input.conversationId ? String(input.conversationId) : null,
            type: 'urgent_notify',
            payload: { tier, title, message, voice },
            summary: `🚨 জরুরি কল: ${title}\n\n${message.slice(0, 200)}`,
            costEstimate: 0.05,
            status: 'pending',
          },
        })
        return {
          success: true,
          data: { pendingActionId: action.id, message: 'Tier-3 urgent alert needs Approve before call.' },
        }
      }

      const dispatched = await dispatchUrgentNow({ tier, title, message, voice })
      if (!dispatched.ok) return { success: false, error: dispatched.error }

      return {
        success: true,
        data: { tier, title, message: 'Critical alert dispatched (ntfy + Telegram).' },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const REMINDER_TOOLS: AgentTool[] = [
  set_reminder,
  list_reminders,
  cancel_reminder,
  snooze_reminder,
  send_urgent_alert,
]
