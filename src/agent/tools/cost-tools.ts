/**
 * Phase 8 — Subscription tracker tools (confirm card for add).
 */
import { prisma } from '@/lib/prisma'
import type { AgentTool } from './registry'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const list_subscriptions: AgentTool = {
  name: 'list_subscriptions',
  description: 'Lists active AI/software subscriptions tracked for cost dashboard (renewal dates, amounts).',
  input_schema: {
    type: 'object' as const,
    properties: {
      includeInactive: { type: 'boolean', description: 'Include deactivated subscriptions' },
    },
  },
  handler: async (input) => {
    try {
      const rows = await db.agentSubscription.findMany({
        where: input.includeInactive ? {} : { active: true },
        orderBy: { nextRenewalAt: 'asc' },
      })
      return {
        success: true,
        data: rows.map((s: {
          id: string; name: string; amount: unknown; currency: string
          billingCycle: string; nextRenewalAt: Date; category: string | null; active: boolean
        }) => ({
          id: s.id,
          name: s.name,
          amount: parseFloat(String(s.amount)),
          currency: s.currency,
          billingCycle: s.billingCycle,
          nextRenewalAt: s.nextRenewalAt.toISOString().slice(0, 10),
          category: s.category,
          active: s.active,
        })),
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const add_subscription: AgentTool = {
  name: 'add_subscription',
  description:
    'Adds a recurring AI/software subscription to the cost tracker. Creates a PENDING ACTION (confirm card). ' +
    'Example: "ChatGPT Plus $20 monthly, renew on 15th".',
  input_schema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Subscription name (e.g. ChatGPT Plus)' },
      amount: { type: 'number', description: 'Recurring amount in USD (or specify currency)' },
      currency: { type: 'string', enum: ['USD', 'BDT'], description: 'Default USD' },
      billingCycle: { type: 'string', enum: ['monthly', 'yearly'] },
      nextRenewalAt: { type: 'string', description: 'Next renewal date YYYY-MM-DD' },
      category: { type: 'string', description: 'e.g. chat, image, hosting' },
      notes: { type: 'string' },
      conversationId: { type: 'string' },
    },
    required: ['name', 'amount', 'nextRenewalAt'],
  },
  handler: async (input) => {
    try {
      const name = String(input.name).trim()
      const amount = Number(input.amount)
      const currency = (input.currency as string) || 'USD'
      const billingCycle = input.billingCycle === 'yearly' ? 'yearly' : 'monthly'
      const nextRenewalAt = String(input.nextRenewalAt)

      if (!name || !Number.isFinite(amount) || amount <= 0) {
        return { success: false, error: 'name and positive amount required' }
      }

      const summary =
        `সাবস্ক্রিপশন যোগ: ${name} — ${currency} ${amount}/${billingCycle === 'yearly' ? 'বছর' : 'মাস'}, ` +
        `পরবর্তী নবায়ন: ${nextRenewalAt}`

      const action = await db.agentPendingAction.create({
        data: {
          conversationId: input.conversationId ? String(input.conversationId) : null,
          type: 'add_subscription',
          payload: {
            name, amount, currency, billingCycle, nextRenewalAt,
            category: input.category ?? null,
            notes: input.notes ?? null,
            conversationId: input.conversationId ?? null,
          },
          summary,
          costEstimate: 0,
          status: 'pending',
        },
      })

      return {
        success: true,
        data: {
          pendingActionId: action.id as string,
          summary,
          message: 'Subscription add request created — awaiting your approval.',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const COST_TOOLS: AgentTool[] = [list_subscriptions, add_subscription]
