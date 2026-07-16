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
import { buildAttributionReport } from '@/agent/lib/marketing/attribution'
import { buildUtm, validateUtm, applyUtmToUrl, buildCampaignSlug, type UtmParams } from '@/agent/lib/marketing/utm'
import { capiHealth, sendCapiEvents } from '@/agent/lib/marketing/meta-capi'
import { makeEvent, type CanonicalEventName } from '@/agent/lib/marketing/event-contract'
import { fetchGa4EventCounts } from '@/agent/lib/ga4'
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

const marketing_attribution_report: AgentTool = {
  name: 'marketing_attribution_report',
  description:
    'Profit-first attribution + cross-source reconciliation: spend vs delivered/confirmed revenue vs event ledger vs ' +
    'GA4, every number labelled observed/modelled/unknown (never quote modelled as fact). Includes CAPI pipeline ' +
    'health and count-mismatch issues with a confidence score. Read-only.',
  input_schema: {
    type: 'object' as const,
    properties: {
      windowDays: { type: 'number', description: 'Lookback 1–30 days (default 7)' },
      fallbackMarginPct: { type: 'number', description: 'Gross margin %% from the growth brief when COGS truth is missing' },
    },
  },
  handler: async (input) => {
    try {
      const days = Math.min(Math.max(Number(input.windowDays ?? 7), 1), 30)
      const [ga4Counts, health] = await Promise.all([
        fetchGa4EventCounts(['purchase', 'key_event'], days),
        capiHealth(),
      ])
      const ga4KeyEvents = ga4Counts ? Object.values(ga4Counts).reduce((s, n) => s + n, 0) : null
      const report = await buildAttributionReport({
        windowDays: days,
        fallbackMarginPct: input.fallbackMarginPct == null ? null : Number(input.fallbackMarginPct),
        ga4KeyEvents,
        metaPurchases: null,
      })
      return { success: true, data: { ...report, capi: health } }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

const utm_build: AgentTool = {
  name: 'utm_build',
  description:
    'Generate/validate convention-correct UTM parameters (alma_<objective>_<yyyymm> campaigns, ' +
    'adset__ad__creative lineage in utm_content) and optionally apply them to a URL. Pure — no side effects. ' +
    'EVERY paid/organic link must go through this before shipping.',
  input_schema: {
    type: 'object' as const,
    properties: {
      source: { type: 'string', description: 'meta | google | organic | referral | direct' },
      medium: { type: 'string', description: 'paid_social | organic_social | cpc | email | sms | messenger' },
      objective: { type: 'string', description: 'Campaign objective slug, e.g. "cod_orders"' },
      yyyymm: { type: 'string', description: '6-digit month, e.g. 202607' },
      campaignSlug: { type: 'string', description: 'Optional extra campaign slug' },
      adsetKey: { type: 'string' },
      adKey: { type: 'string' },
      creativeKey: { type: 'string' },
      url: { type: 'string', description: 'Optional destination URL to append the UTMs to' },
    },
    required: ['source', 'medium', 'objective', 'yyyymm'],
  },
  handler: async (input) => {
    try {
      const campaign = buildCampaignSlug({
        objective: String(input.objective),
        yyyymm: String(input.yyyymm),
        slug: input.campaignSlug ? String(input.campaignSlug) : undefined,
      })
      const utm = buildUtm({
        source: String(input.source) as UtmParams['utm_source'] & ('meta' | 'google' | 'organic' | 'referral' | 'direct'),
        medium: String(input.medium) as 'paid_social' | 'organic_social' | 'cpc' | 'email' | 'sms' | 'messenger',
        campaign,
        adsetKey: input.adsetKey ? String(input.adsetKey) : undefined,
        adKey: input.adKey ? String(input.adKey) : undefined,
        creativeKey: input.creativeKey ? String(input.creativeKey) : undefined,
      })
      const validation = validateUtm(utm)
      const url = input.url ? applyUtmToUrl(String(input.url), utm) : null
      return { success: true, data: { utm, validation, url } }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

const marketing_capi_test_event: AgentTool = {
  name: 'marketing_capi_test_event',
  description:
    'Send a TEST event to the Meta Conversions API (requires testEventCode from Events Manager → Test Events — test ' +
    'events never affect ad optimization or public data). Proves the Pixel/CAPI dedup pipeline end-to-end. Deterministic ' +
    'event_id: retrying the same logical event dedupes instead of double-counting. Raw PII is hashed before sending.',
  input_schema: {
    type: 'object' as const,
    properties: {
      testEventCode: { type: 'string', description: 'REQUIRED — Events Manager test code (e.g. TEST12345)' },
      name: { type: 'string', description: 'Canonical event: page_view|product_view|lead|messenger_conversation|order_draft|order_confirmed|order_delivered|refund|repeat_purchase' },
      orderId: { type: 'string', description: 'Order id (required for order_* / refund)' },
      dedupKey: { type: 'string', description: 'Stable identity for non-order events' },
      valueBdt: { type: 'number', description: 'Whole-taka value (optional)' },
    },
    required: ['testEventCode', 'name'],
  },
  handler: async (input) => {
    try {
      const testEventCode = String(input.testEventCode ?? '').trim()
      if (!testEventCode) {
        return { success: false, error: 'testEventCode is required — this tool only sends Meta TEST events, never production traffic.' }
      }
      const event = makeEvent({
        name: String(input.name) as CanonicalEventName,
        source: 'server',
        occurredAt: new Date(),
        valueBdt: input.valueBdt == null ? null : Number(input.valueBdt),
        orderId: input.orderId ? String(input.orderId) : null,
        dedupKey: input.dedupKey ? String(input.dedupKey) : null,
      })
      const result = await sendCapiEvents([event], { testEventCode })
      return result.ok
        ? { success: true, data: { eventId: event.eventId, ...result, note: 'Check Events Manager → Test Events to see it arrive.' } }
        : { success: false, error: result.error ?? 'send failed' }
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
  marketing_attribution_report,
  utm_build,
  marketing_capi_test_event,
]

export const MARKETING_ROLE_PROMPT = `
## MARKETING STRATEGIST (File 13 — extends daily strategist, marketing-scoped)
plan_marketing: calendar-aware draft plan → owner approval → File 10 ad briefs + organic staff tasks. NO auto-post/spend.
marketing_report: paid + Messenger + COD funnel report with 2–3 moves. Directional — thin data = say so.
marketing_capability_audit: probe-proven capability matrix + measurement health. Run before big campaign/attribution claims.
growth_strategy_run → proposal (bottleneck + options + forecast ranges) → owner decides → growth_brief_draft + growth_brief_approve freezes strategy.
plan_marketing requires an approved Growth Brief (budget boundary, objective, segments) — kv growth.brief.enforce=false disables the gate.
marketing_attribution_report: profit + reconciliation, observed/modelled/unknown labels — modelled ≠ fact.
utm_build: every shipped link gets convention UTMs. marketing_capi_test_event: test-code-only CAPI pipeline proof.
Do NOT duplicate general strategist (inventory/staff cross-domain) — use advisor_data_bundle topic=marketing if needed.
`
