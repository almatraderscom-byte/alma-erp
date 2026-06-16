/**
 * Phase 8 — Subscription tracker + API balance tools.
 */
import { prisma } from '@/lib/prisma'
import type { AgentTool } from './registry'
import {
  getApiBalances,
  normalizeBalanceProvider,
  setApiCredit,
  type BalanceProviderId,
} from '@/agent/lib/api-balances'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const CREDIT_PROVIDERS: BalanceProviderId[] = ['anthropic', 'openai', 'gemini', 'google_tts', 'oxylabs', 'elevenlabs', 'veo']

const set_api_credit: AgentTool = {
  name: 'set_api_credit',
  description:
    'Sets owner-reported API wallet credit for a provider (e.g. "Claude e 50 dollar recharge korlam"). ' +
    'Balance = credit minus tracked spend since top-up. Providers: anthropic/claude, openai, gemini, google_tts, oxylabs, elevenlabs, veo/VEO 3 (Hostinger API key credits).',
  input_schema: {
    type: 'object' as const,
    properties: {
      provider: { type: 'string', description: 'Provider name or alias (claude, anthropic, gemini, openai, google_tts, oxylabs, elevenlabs, veo)' },
      amount: { type: 'number', description: 'Current credit balance in USD after recharge' },
      currency: { type: 'string', enum: ['USD'], description: 'Default USD' },
    },
    required: ['provider', 'amount'],
  },
  handler: async (input) => {
    try {
      const provider = normalizeBalanceProvider(String(input.provider))
      if (!provider || !CREDIT_PROVIDERS.includes(provider)) {
        return { success: false, error: `Unknown provider. Use: ${CREDIT_PROVIDERS.join(', ')}` }
      }
      const amount = Number(input.amount)
      if (!Number.isFinite(amount) || amount < 0) {
        return { success: false, error: 'amount must be a non-negative number' }
      }
      const credit = await setApiCredit(provider, amount, (input.currency as string) || 'USD')
      const cache = await getApiBalances({ refresh: true })
      const row = cache.providers.find((p) => p.id === provider)
      return {
        success: true,
        data: {
          provider,
          credit,
          balanceUsd: row?.balanceUsd ?? amount,
          message: `${provider} credit $${amount} set — refreshed balance cache.`,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const get_api_balances: AgentTool = {
  name: 'get_api_balances',
  description: 'Returns all API provider balances for cost dashboard (live Twilio, credit-tracked others, free services).',
  input_schema: {
    type: 'object' as const,
    properties: {
      refresh: { type: 'boolean', description: 'Force refresh from provider APIs before returning' },
    },
  },
  handler: async (input) => {
    try {
      const cache = await getApiBalances({ refresh: Boolean(input.refresh) })
      return { success: true, data: cache }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

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

export const COST_TOOLS: AgentTool[] = [
  set_api_credit,
  get_api_balances,
  list_subscriptions,
  add_subscription,
]
