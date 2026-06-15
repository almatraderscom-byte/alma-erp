import { createMarketingPlanCard } from '@/agent/lib/marketing/planner'
import { buildMarketingReportText } from '@/agent/lib/marketing/report'
import type { AgentTool } from './registry'

const plan_marketing: AgentTool = {
  name: 'plan_marketing',
  description:
    'Draft a 2–4 week marketing plan tied to retail calendar, stock, ad performance, and winning creative angles. ' +
    'High-leverage items only — no daily busywork. Creates owner approval card; approved items orchestrate to ' +
    'make_ad_creatives briefs and organic staff tasks (nothing auto-posts/spends). Marketing extension of strategist — not duplicate.',
  input_schema: {
    type: 'object' as const,
    properties: {
      weeks: { type: 'number', description: 'Planning horizon 1–4 weeks (default 2)' },
      conversationId: { type: 'string' },
    },
  },
  handler: async (input) => {
    try {
      const weeks = Math.min(Math.max(Number(input.weeks ?? 2), 1), 4)
      const result = await createMarketingPlanCard({
        weeks,
        conversationId: input.conversationId ? String(input.conversationId) : null,
      })
      return {
        success: true,
        data: {
          pendingActionId: result.pendingActionId,
          summary: result.summary,
          itemCount: result.itemCount,
          thinData: result.thinData,
          message: 'Marketing plan draft — owner must approve before any creative/task orchestration.',
        },
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

const marketing_report: AgentTool = {
  name: 'marketing_report',
  description:
    'On-demand weekly marketing funnel report: paid (Meta spend/ROAS/angles), Messenger→COD funnel, organic activity, ' +
    '2–3 concrete recommendations. Directional attribution — honest about thin data.',
  input_schema: {
    type: 'object' as const,
    properties: {
      periodDays: { type: 'number', description: 'Lookback days 1–30 (default 7)' },
    },
  },
  handler: async (input) => {
    try {
      const days = Math.min(Math.max(Number(input.periodDays ?? 7), 1), 30)
      const { report, data, recommendations } = await buildMarketingReportText(days)
      return {
        success: true,
        data: {
          report,
          recommendations,
          periodDays: days,
          thinData: data.paid.thinData || data.funnel.thinData,
        },
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

export const MARKETING_TOOLS: AgentTool[] = [plan_marketing, marketing_report]

export const MARKETING_ROLE_PROMPT = `
## MARKETING STRATEGIST (File 13 — extends daily strategist, marketing-scoped)
plan_marketing: calendar-aware draft plan → owner approval → File 10 ad briefs + organic staff tasks. NO auto-post/spend.
marketing_report: paid + Messenger + COD funnel report with 2–3 moves. Directional — thin data = say so.
Do NOT duplicate general strategist (inventory/staff cross-domain) — use advisor_data_bundle topic=marketing if needed.
`
