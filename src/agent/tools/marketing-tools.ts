import { createMarketingPlanCard } from '@/agent/lib/marketing/planner'
import { buildMarketingReportText } from '@/agent/lib/marketing/report'
import { runCapabilityAudit } from '@/agent/lib/marketing/capability-audit'
import { assessMeasurementHealth } from '@/agent/lib/marketing/measurement-health'
import {
  approveBrief,
  createDraftBrief,
  getApprovedBrief,
  listBriefHistory,
  validateBriefForPlanning,
  type GrowthBriefContent,
} from '@/agent/lib/marketing/growth-brief'
import { recordOwnerDecision, runStrategyFlow } from '@/agent/lib/marketing/growth-strategy-graph'
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

const growth_brief_get: AgentTool = {
  name: 'growth_brief_get',
  description:
    'Read the Growth Brief (versioned business strategy memory): current approved version, or full history. ' +
    'Also returns planning-readiness (which required fields are missing). Read-only.',
  input_schema: {
    type: 'object' as const,
    properties: {
      history: { type: 'boolean', description: 'true = return version history (default: approved only)' },
    },
  },
  handler: async (input) => {
    try {
      if (input.history) {
        const rows = await listBriefHistory('ALMA_LIFESTYLE')
        return { success: true, data: { history: rows.map((r) => ({ id: r.id, version: r.version, status: r.status, changeReason: r.changeReason, approvedAt: r.approvedAt, createdAt: r.createdAt })) } }
      }
      const brief = await getApprovedBrief('ALMA_LIFESTYLE')
      const validation = validateBriefForPlanning(brief?.brief ?? null)
      return { success: true, data: { brief, planningReady: validation.ok, missing: validation.missing } }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

const growth_brief_draft: AgentTool = {
  name: 'growth_brief_draft',
  description:
    'Create a NEW draft version of the Growth Brief (goals, focus products + availability + margin, customer segments, ' +
    'objective, measurement plan, monthly budget cap BDT, seasonality, risks). History is preserved — a revision needs ' +
    'changeReason. Draft only; the owner approves separately via growth_brief_approve. Facts/inference/recommendation ' +
    'must be tagged separately in statements.',
  input_schema: {
    type: 'object' as const,
    properties: {
      content: { type: 'object', description: 'GrowthBriefContent JSON (goals, products.focus[], economics, customers.segments[], objective, measurementPlan, …)' },
      changeReason: { type: 'string', description: 'Required from v2 onward — why the strategy changed' },
    },
    required: ['content'],
  },
  handler: async (input) => {
    try {
      const content = input.content as unknown as GrowthBriefContent
      const row = await createDraftBrief({
        content,
        changeReason: input.changeReason ? String(input.changeReason) : null,
      })
      const validation = validateBriefForPlanning(content)
      return {
        success: true,
        data: {
          id: row.id,
          version: row.version,
          status: row.status,
          planningReady: validation.ok,
          missing: validation.missing,
          message: validation.ok
            ? 'Draft তৈরি। Owner approve করলে এটাই active strategy হবে।'
            : `Draft তৈরি, কিন্তু অসম্পূর্ণ — missing: ${validation.missing.join('; ')}`,
        },
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

const growth_brief_approve: AgentTool = {
  name: 'growth_brief_approve',
  description:
    'Freeze a draft Growth Brief as the approved strategy (previous approved version becomes superseded — history kept). ' +
    'ONLY call after the owner explicitly said yes to this specific version in chat. Rejects incomplete briefs.',
  input_schema: {
    type: 'object' as const,
    properties: {
      briefId: { type: 'string', description: 'Draft brief id to approve' },
      ownerConfirmed: { type: 'boolean', description: 'Must be true — the owner explicitly approved THIS version in conversation' },
    },
    required: ['briefId', 'ownerConfirmed'],
  },
  handler: async (input) => {
    try {
      if (input.ownerConfirmed !== true) {
        return { success: false, error: 'Owner confirmation required — ask the owner to approve this brief version first.' }
      }
      const row = await approveBrief(String(input.briefId))
      await recordOwnerDecision('ALMA_LIFESTYLE', { briefId: row.id, decision: 'approved' })
      return { success: true, data: { id: row.id, version: row.version, status: row.status, approvedAt: row.approvedAt } }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

const growth_strategy_run: AgentTool = {
  name: 'growth_strategy_run',
  description:
    'Run the growth strategy flow: load business truth (measurement health + capability audit) → missing data → ' +
    'bottleneck diagnosis → 2 strategy options with assumptions + forecast RANGES → 90d/month/week plan skeleton. ' +
    'Returns a proposal for the owner to decide on (nothing auto-executes). Durable growth:<business> thread.',
  input_schema: {
    type: 'object' as const,
    properties: {
      windowDays: { type: 'number', description: 'Measurement lookback days 1–30 (default 7)' },
    },
  },
  handler: async (input) => {
    try {
      const days = Math.min(Math.max(Number(input.windowDays ?? 7), 1), 30)
      const [measurement, capabilities, approved] = await Promise.all([
        assessMeasurementHealth(days),
        runCapabilityAudit(),
        getApprovedBrief('ALMA_LIFESTYLE'),
      ])
      const proposal = await runStrategyFlow('ALMA_LIFESTYLE', {
        measurement,
        capabilities,
        draftBrief: approved?.brief ?? null,
      })
      return {
        success: true,
        data: {
          proposal,
          note: 'Options are recommendations with assumption-tagged forecast ranges — owner decides; approval freezes the brief.',
        },
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

export const MARKETING_TOOLS: AgentTool[] = [
  plan_marketing,
  marketing_report,
  marketing_capability_audit,
  growth_brief_get,
  growth_brief_draft,
  growth_brief_approve,
  growth_strategy_run,
]

export const MARKETING_ROLE_PROMPT = `
## MARKETING STRATEGIST (File 13 — extends daily strategist, marketing-scoped)
plan_marketing: calendar-aware draft plan → owner approval → File 10 ad briefs + organic staff tasks. NO auto-post/spend.
marketing_report: paid + Messenger + COD funnel report with 2–3 moves. Directional — thin data = say so.
marketing_capability_audit: probe-proven capability matrix + measurement health. Run before big campaign/attribution claims.
growth_strategy_run → proposal (bottleneck + options + forecast ranges) → owner decides → growth_brief_draft + growth_brief_approve freezes strategy.
plan_marketing requires an approved Growth Brief (budget boundary, objective, segments) — kv growth.brief.enforce=false disables the gate.
Do NOT duplicate general strategist (inventory/staff cross-domain) — use advisor_data_bundle topic=marketing if needed.
`
