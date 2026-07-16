import { createMarketingPlanCard } from '@/agent/lib/marketing/planner'
import { buildMarketingReportText } from '@/agent/lib/marketing/report'
import { runCapabilityAudit } from '@/agent/lib/marketing/capability-audit'
import { assessMeasurementHealth } from '@/agent/lib/marketing/measurement-health'
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
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
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

const marketing_capability_audit: AgentTool = {
  name: 'marketing_capability_audit',
  description:
    'Read-only audit: which marketing capabilities (Meta pages/ads/pixel/IG, GA4, GSC, website, WhatsApp, GBP) are ' +
    'actually reachable right now — probe-proven read/stage vs unknown/broken/unsupported — plus measurement health ' +
    '(ERP funnel vs GA4 vs spend, data gaps, thin-data flag). No env-presence green, no external writes. ' +
    'Use before planning campaigns or trusting attribution.',
  input_schema: {
    type: 'object' as const,
    properties: {
      windowDays: { type: 'number', description: 'Measurement lookback days 1–30 (default 7)' },
    },
  },
  handler: async (input) => {
    try {
      const days = Math.min(Math.max(Number(input.windowDays ?? 7), 1), 30)
      const [capabilities, measurement] = await Promise.all([
        runCapabilityAudit(),
        assessMeasurementHealth(days).catch((err) => ({ error: err instanceof Error ? err.message : String(err) })),
      ])
      return { success: true, data: { capabilities, measurement } }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

export const MARKETING_TOOLS: AgentTool[] = [plan_marketing, marketing_report, marketing_capability_audit]

export const MARKETING_ROLE_PROMPT = `
## MARKETING STRATEGIST (File 13 — extends daily strategist, marketing-scoped)
plan_marketing: calendar-aware draft plan → owner approval → File 10 ad briefs + organic staff tasks. NO auto-post/spend.
marketing_report: paid + Messenger + COD funnel report with 2–3 moves. Directional — thin data = say so.
marketing_capability_audit: probe-proven capability matrix + measurement health. Run before big campaign/attribution claims.
Do NOT duplicate general strategist (inventory/staff cross-domain) — use advisor_data_bundle topic=marketing if needed.
`
