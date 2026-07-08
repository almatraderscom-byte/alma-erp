import type Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/prisma'
import { embed, vectorLiteral } from '@/agent/lib/embeddings'
import { logToolEvent } from '@/agent/lib/tool-telemetry'
import { attachMemoryEmbedding, createOrUpdateAgentMemory } from '@/agent/lib/agent-memory'
import { ERP_TOOLS } from './erp-tools'
import { CONFIRM_TOOLS } from './confirm-tools'
import { WA_TOOLS } from './wa-tools'
import { STAFF_TOOLS } from './staff-tools'
import { SETTINGS_TOOLS } from './settings-tools'
import { SALAH_TOOLS } from './salah-tools'
import { FINANCE_TOOLS } from './finance-tools'
import { OWNER_CUSTOMER_INTEL_TOOLS } from './cs-tools'
import { CS_AUTONOMY_TOOLS } from './cs-autonomy-tools'
import { ORDER_AUTONOMY_TOOLS } from './order-autonomy-tools'
import { FINANCE_AUTONOMY_TOOLS } from './finance-autonomy-tools'
import { COST_TOOLS } from './cost-tools'
import { REMINDER_TOOLS } from './reminder-tools'
import { ASK_TOOLS } from './ask-tools'
import { ADS_TOOLS } from './ads-tools'
import { LOCATION_TOOLS } from './location-tools'
import { CAMERA_TOOLS } from './camera-tools'
import { CATALOG_TOOLS } from './catalog-tools'
import { WEBSITE_TOOLS } from './website-tools'
import { RESEARCH_TOOLS } from './research-tools'
import { SEO_TOOLS } from './seo-tools'
import { ANALYTICS_TOOLS } from './analytics-tools'
import { CAMPAIGN_TOOLS } from './campaign-tools'
import { GBP_TOOLS } from './gbp-tools'
import { GROWTH_TOOLS } from './growth-tools'
import { COMPETITOR_TOOLS } from './competitor-tools'
import { ADVISOR_TOOLS } from './advisor-tools'
import { FAMILY_TOOLS, place_agent_call } from './personal-tools'
import { OWNER_TODO_TOOLS } from './owner-todo-tools'
import { TRYON_TOOLS } from './tryon-tools'
import { STUDIO_TOOLS } from './studio-tools'
import { DIAGNOSTIC_TOOLS } from './diagnostic-tools'
import { CONTENT_ENGINE_TOOLS } from './content-engine-tools'
import { COWORKER_TOOLS } from './coworker-tools'
import { AD_CREATIVE_TOOLS } from './ad-creative-tools' // make_ad_creatives
import { VIDEO_TOOLS } from './video-tools' // make_product_reel
import { MARKETING_TOOLS } from './marketing-tools' // plan_marketing, marketing_report
import { BRAND_TOOLS } from './brand-tools'
import { TRADING_READ_TOOLS } from './trading-tools'
import { PLAYBOOK_TOOLS } from './playbook-tools'
import { LEARNING_TOOLS } from './learning-tools'
import { REFERENCE_TOOLS } from './reference-tools'
import { QC_TOOLS } from './qc-tools'
import { VISION_TOOLS } from './vision-tools'
import { SIMULATE_TOOLS } from './simulate-tools'
import { WORK_TODO_TOOLS } from './work-todo-tools'
import { ORCHESTRATOR_TOOLS } from './orchestrator-tools'
import { AUTONOMY_TOOLS } from './autonomy-tools'
import { HEARTBEAT_TOOLS } from './heartbeat-tools'
import { BILLS_TOOLS } from './bills-tools'
import { IMPORTANT_DATE_TOOLS } from './important-dates-tools'
import { PERSONAL_BRIEFING_TOOLS } from './personal-briefing-tools'
import { APPOINTMENT_TOOLS } from './appointment-tools'
import { HEALTH_TOOLS } from './health-tools'
import { DOCUMENT_TOOLS } from './document-tools'
import { GRAPH_TOOLS } from './graph-tools'
import { OPEN_TASK_TOOLS } from './open-task-tools'
import { BROWSER_TOOLS } from './browser-tools'
import { BROWSER_RECIPE_TOOLS } from './browser-recipe-tools'
import { NATIVE_PUSH_TOOLS } from './native-push-tools'
import { LIVE_BROWSER_TOOLS } from './live-browser-tools'
import { WORKBENCH_TOOLS } from './workbench-tools'
import { SKILL_PACK_TOOLS } from './skill-pack-tools'
import { SEO_AUDIT_TOOLS } from './seo-audit-tools'

export interface ToolResult {
  success: boolean
  data?: unknown
  error?: string
  /**
   * Optional screenshot/image to hand the head model as a REAL vision block
   * (not a URL string). The core loop strips this out of the JSON text payload
   * and attaches it as an `image` content block in the tool_result, so the model
   * literally SEES the page — the way Claude sees a browser — instead of guessing
   * from text/DOM alone. `data` is raw base64 (no data: prefix).
   */
  image?: { data: string; mediaType: 'image/jpeg' | 'image/png' }
}

export interface AgentTool {
  name: string
  description: string
  input_schema: Anthropic.Messages.Tool['input_schema']
  handler: (input: Record<string, unknown>) => Promise<ToolResult>
}

const get_current_datetime: AgentTool = {
  name: 'get_current_datetime',
  description:
    'Returns the current date and time in Asia/Dhaka timezone (Bangladesh Standard Time, UTC+6).',
  input_schema: { type: 'object' as const, properties: {} },
  handler: async () => {
    const now = new Date()
    const opts: Intl.DateTimeFormatOptions = {
      timeZone: 'Asia/Dhaka',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }
    return {
      success: true,
      data: {
        iso: now.toISOString(),
        dhaka: now.toLocaleString('en-BD', opts),
        weekday: now.toLocaleDateString('en-BD', { timeZone: 'Asia/Dhaka', weekday: 'long' }),
        timezone: 'Asia/Dhaka (UTC+6)',
      },
    }
  },
}

const list_agent_projects: AgentTool = {
  name: 'list_agent_projects',
  description: 'Lists all agent projects configured in ALMA ERP.',
  input_schema: { type: 'object' as const, properties: {} },
  handler: async () => {
    try {
      const projects = await prisma.agentProject.findMany({
        select: { id: true, name: true, description: true },
        orderBy: { name: 'asc' },
      })
      return { success: true, data: projects }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── Memory tools ───────────────────────────────────────────────────────────

const MEMORY_SCOPES = ['personal', 'business', 'staff'] as const
type MemoryScope = typeof MEMORY_SCOPES[number]

const save_memory: AgentTool = {
  name: 'save_memory',
  description:
    'Saves a durable fact to long-term memory with semantic embedding. Use when the owner states a preference, business fact, person, or recurring pattern. Trigger phrase: "মনে রাখো…". Use scope=business + key (e.g. contact_phone, contact_website) + pinned=true for standing contact info. Never save secrets or API keys. Business scope (Lifestyle vs Trading) is auto-tagged from server context. ' +
    'HARD RULE — duration: classify EVERY fact before saving. A fact that only matters today or for one dated event ("আজ অফিস ছুটি", "৮ জুলাই সফরে", today\'s salah status) MUST be duration "today" (or "7d" if it matters this week). Only lifelong preferences, standing rules, contacts and stable business facts are "permanent". When unsure, pick the SHORTER duration — permanent junk pollutes context and costs the owner money forever.',
  input_schema: {
    type: 'object' as const,
    properties: {
      scope: { type: 'string', enum: ['personal', 'business', 'staff'], description: 'Memory scope' },
      key: { type: 'string', description: 'Optional short identifier for the fact' },
      content: { type: 'string', description: 'The fact to remember (clear, self-contained text)' },
      pinned: { type: 'boolean', description: 'If true, this fact is injected into every conversation system prompt (use for critical standing facts, cap 30)' },
      duration: {
        type: 'string',
        enum: ['permanent', 'today', '7d', '30d'],
        description: 'How long the fact stays alive. "today" = day-scoped (expires end of today, Dhaka); "7d"/"30d" = short-lived; "permanent" = standing fact only.',
      },
      metadata: {
        type: 'object',
        description: 'Optional metadata e.g. { type: "owner_decision", context: "task_proposal", date: "YYYY-MM-DD" }',
      },
    },
    required: ['scope', 'content'],
  },
  handler: async (input) => {
    const scope = (input.scope as MemoryScope) || 'personal'
    const content = String(input.content ?? '')
    const key = input.key ? String(input.key) : null
    const pinned = input.pinned === true
    const businessId = input.businessId === 'ALMA_TRADING' ? 'ALMA_TRADING' : 'ALMA_LIFESTYLE'
    const rawMeta = input.metadata && typeof input.metadata === 'object'
      ? (input.metadata as Record<string, unknown>)
      : {}
    // Tag with businessId for business/staff scopes; personal stays cross-business.
    const metadata: Record<string, unknown> | undefined =
      scope === 'personal'
        ? (Object.keys(rawMeta).length ? rawMeta : undefined)
        : { ...rawMeta, businessId }

    if (!content.trim()) return { success: false, error: 'content is empty' }
    if (!MEMORY_SCOPES.includes(scope)) return { success: false, error: `invalid scope: ${scope}` }

    // duration → expiry. undefined = let the server-side ephemeral hard rule
    // decide (day-scoped content still gets an expiry even without duration).
    const duration = typeof input.duration === 'string' ? input.duration : undefined
    let expiresAt: Date | null | undefined = undefined
    if (duration === 'permanent') expiresAt = null
    else if (duration === 'today') expiresAt = null // resolved below via day rule
    else if (duration === '7d') expiresAt = new Date(Date.now() + 7 * 24 * 3600_000)
    else if (duration === '30d') expiresAt = new Date(Date.now() + 30 * 24 * 3600_000)
    if (duration === 'today') {
      // End of the current Dhaka day (UTC+6, no DST) + a 1-day grace window.
      const dhakaNow = new Date(Date.now() + 6 * 3600_000)
      const endUtc = Date.UTC(dhakaNow.getUTCFullYear(), dhakaNow.getUTCMonth(), dhakaNow.getUTCDate(), 23, 59, 59) - 6 * 3600_000
      expiresAt = new Date(endUtc + 24 * 3600_000)
    }

    try {
      const mem = await createOrUpdateAgentMemory({ scope, key, content, pinned, metadata, expiresAt })
      return {
        success: true,
        data: {
          id: mem.id,
          scope: mem.scope,
          key: mem.key,
          pinned: mem.pinned,
          businessId: scope === 'personal' ? null : businessId,
          preview: content.slice(0, 80),
          embedded: mem.embedStatus.embedded,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const search_memory: AgentTool = {
  name: 'search_memory',
  description:
    'Searches long-term memory using semantic similarity. Use when a question references something that might have been saved but is not in the current conversation.',
  input_schema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string', description: 'Natural language query to find related memories' },
      scope: { type: 'string', enum: ['personal', 'business', 'staff'], description: 'Filter by scope (omit to search all)' },
      limit: { type: 'number', description: 'Max results to return (default 5)' },
    },
    required: ['query'],
  },
  handler: async (input) => {
    const query = String(input.query ?? '')
    const scope = input.scope as MemoryScope | undefined
    const limit = Math.min(Number(input.limit ?? 5), 20)
    const businessId = input.businessId === 'ALMA_TRADING' ? 'ALMA_TRADING' : 'ALMA_LIFESTYLE'

    if (!query.trim()) return { success: false, error: 'query is empty' }
    // Validate scope against the allow-list: the model can emit arbitrary strings
    // (Anthropic does not enforce input_schema enums server-side), so an unchecked
    // scope must never reach a SQL clause.
    if (scope && !MEMORY_SCOPES.includes(scope)) {
      return { success: false, error: `invalid scope: ${String(scope)}` }
    }

    /**
     * Business filter: Trading context should NOT see Lifestyle-tagged memories
     * (and vice versa). Personal-scope memories are cross-business (no filter).
     * Untagged legacy memories default to ALMA_LIFESTYLE — included only when
     * the current context is ALMA_LIFESTYLE.
     */
    const businessFilter =
      businessId === 'ALMA_TRADING'
        ? `metadata->>'businessId' = 'ALMA_TRADING'`
        : `(metadata->>'businessId' IS NULL OR metadata->>'businessId' = 'ALMA_LIFESTYLE')`
    // scope='personal' → no business filter (personal memories are cross-business).
    // explicit business/staff scope → business filter only. scope omitted → match
    // business memories for THIS business OR any personal memory, so an owner asking
    // a personal question inside a business thread still finds saved personal facts.
    const businessFilterClause =
      scope === 'personal'
        ? ''
        : scope
          ? `AND ${businessFilter}`
          : `AND (scope = 'personal' OR ${businessFilter})`

    try {
      const embedResult = await embed(query)
      if (!embedResult.success) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rows: Array<{ id: string; scope: string; key: string|null; content: string; pinned: boolean; created_at: Date }> =
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (prisma as any).$queryRawUnsafe(
            `SELECT id, scope, key, content, pinned, "createdAt" AS created_at
             FROM agent_memory
             WHERE content ILIKE $1
               ${scope ? `AND scope = $2` : ''}
               ${businessFilterClause}
             ORDER BY "createdAt" DESC
             LIMIT ${limit}`,
            ...(scope ? [`%${query}%`, scope] : [`%${query}%`]),
          )
        return {
          success: true,
          data: rows.map((r) => ({ ...r, businessId, score: null })),
        }
      }

      const vec = vectorLiteral(embedResult.data)
      // scope is parameterized ($3) — never interpolated — to prevent SQL injection.
      const scopeClause = scope ? `AND scope = $3` : ''
      const rows: Array<{ id: string; scope: string; key: string|null; content: string; pinned: boolean; created_at: Date; score: number }> =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (prisma as any).$queryRawUnsafe(
          `SELECT id, scope, key, content, pinned, "createdAt" AS created_at,
                  1 - (embedding <=> $1::vector) AS score
           FROM agent_memory
           WHERE embedding IS NOT NULL ${scopeClause} ${businessFilterClause}
           ORDER BY embedding <=> $1::vector
           LIMIT $2`,
          ...(scope ? [vec, limit, scope] : [vec, limit]),
        )

      const results = rows
        .filter((r) => r.score >= 0.45)
        .map((r) => ({
          id: r.id, scope: r.scope, key: r.key, content: r.content,
          pinned: r.pinned, score: Math.round(r.score * 100) / 100,
        }))

      return { success: true, data: { businessId, scope: scope ?? 'all', results } }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const update_memory: AgentTool = {
  name: 'update_memory',
  description: 'Updates an existing memory by id. Only use on memories that have been retrieved (via search_memory) in this conversation.',
  input_schema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string', description: 'Memory id from search_memory result' },
      content: { type: 'string', description: 'New content (re-embeds)' },
      pinned: { type: 'boolean', description: 'Update pinned status' },
    },
    required: ['id'],
  },
  handler: async (input) => {
    const id = String(input.id ?? '')
    if (!id) return { success: false, error: 'id is required' }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = prisma as any
      const existing = await db.agentMemory.findUnique({ where: { id }, select: { id: true } })
      if (!existing) return { success: false, error: `Memory ${id} not found` }

      const updateData: Record<string, unknown> = {}
      let contentToEmbed: string | null = null
      if (input.content !== undefined) {
        contentToEmbed = String(input.content)
        updateData.content = contentToEmbed
      }
      if (input.pinned !== undefined) updateData.pinned = input.pinned === true

      const updated = await db.agentMemory.update({
        where: { id },
        data: updateData,
        select: { id: true, scope: true, content: true, pinned: true },
      })
      if (contentToEmbed) {
        await attachMemoryEmbedding(id, contentToEmbed)
      }
      return { success: true, data: updated }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const delete_memory: AgentTool = {
  name: 'delete_memory',
  description: 'Deletes a memory by id. Only delete memories that were explicitly retrieved via search_memory in this conversation — never delete blindly.',
  input_schema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string', description: 'Memory id from search_memory result' },
    },
    required: ['id'],
  },
  handler: async (input) => {
    const id = String(input.id ?? '')
    if (!id) return { success: false, error: 'id is required' }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = prisma as any
      const existing = await db.agentMemory.findUnique({ where: { id }, select: { id: true, scope: true } })
      if (!existing) return { success: false, error: `Memory ${id} not found` }

      await db.agentMemory.delete({ where: { id } })
      return { success: true, data: { deleted: id } }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

/** Personal reminders only — no business urgent/outbound tools (use call_family_member). */
const PERSONAL_REMINDER_TOOLS: AgentTool[] = REMINDER_TOOLS.filter(
  (t) => !['send_urgent_alert', 'get_outbound_call_status', 'outbound_phone_call', 'preview_call_voice'].includes(t.name),
)

export const PERSONAL_SAFE_TOOLS: AgentTool[] = [
  get_current_datetime,
  save_memory,
  search_memory,
  update_memory,
  delete_memory,
  ...PERSONAL_REMINDER_TOOLS,
  ...FAMILY_TOOLS,
  ...BILLS_TOOLS,
  ...IMPORTANT_DATE_TOOLS,
  ...PERSONAL_BRIEFING_TOOLS,
  ...APPOINTMENT_TOOLS,
  ...HEALTH_TOOLS,
  ...DOCUMENT_TOOLS,
]

export const PERSONAL_SAFE_TOOL_NAMES = PERSONAL_SAFE_TOOLS.map((t) => t.name)

export const PERSONAL_TOOL_DEFINITIONS: Anthropic.Messages.Tool[] = PERSONAL_SAFE_TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.input_schema,
}))

export async function executePersonalTool(
  name: string,
  input: Record<string, unknown>,
  serverContext: Record<string, unknown> = {},
): Promise<ToolResult> {
  const tool = PERSONAL_SAFE_TOOLS.find((t) => t.name === name)
  if (!tool) return { success: false, error: `Unknown personal tool: ${name}` }
  try {
    return await tool.handler({ ...input, ...serverContext })
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

export const CORE_AGENT_TOOLS: AgentTool[] = [
  get_current_datetime,
  list_agent_projects,
  save_memory,
  search_memory,
  update_memory,
  delete_memory,
  ...GRAPH_TOOLS,
  ...OPEN_TASK_TOOLS,
  ...BROWSER_TOOLS,
  ...BROWSER_RECIPE_TOOLS,
  ...NATIVE_PUSH_TOOLS,
  ...LIVE_BROWSER_TOOLS,
  ...WORKBENCH_TOOLS,
  ...SKILL_PACK_TOOLS,
  ...SEO_AUDIT_TOOLS,
]

/** Lifestyle-only tools beyond CORE + base groups (not in TOOL_GROUPS.base). */
export const TRADING_EXTENSION_TOOLS: AgentTool[] = [
  ...TRADING_READ_TOOLS,
  ...STAFF_TOOLS,
  ...CONFIRM_TOOLS,
  ...SETTINGS_TOOLS,
  ...SALAH_TOOLS,
  ...FINANCE_TOOLS,
  ...ADVISOR_TOOLS,
  ...DIAGNOSTIC_TOOLS,
  ...FAMILY_TOOLS,
]

/** Full execution pool for ALMA_TRADING (dynamic loading only affects model-facing definitions). */
export const TRADING_TOOLS: AgentTool[] = [
  ...CORE_AGENT_TOOLS,
  ...TRADING_EXTENSION_TOOLS,
  ...COST_TOOLS,
  ...REMINDER_TOOLS,
  ...ASK_TOOLS,
  ...OWNER_TODO_TOOLS,
  ...PLAYBOOK_TOOLS,
  ...WORK_TODO_TOOLS,
  ...ORCHESTRATOR_TOOLS,
  ...AUTONOMY_TOOLS,
  ...HEARTBEAT_TOOLS,
  ...CS_AUTONOMY_TOOLS,
  ...ORDER_AUTONOMY_TOOLS,
  ...FINANCE_AUTONOMY_TOOLS,
  ...BILLS_TOOLS,
  ...IMPORTANT_DATE_TOOLS,
  ...PERSONAL_BRIEFING_TOOLS,
  ...APPOINTMENT_TOOLS,
  ...HEALTH_TOOLS,
  ...DOCUMENT_TOOLS,
]

export const TOOLS: AgentTool[] = [
  ...CORE_AGENT_TOOLS,
  ...ERP_TOOLS,
  ...CONFIRM_TOOLS,
  ...WA_TOOLS,
  ...STAFF_TOOLS,
  ...SETTINGS_TOOLS,
  ...SALAH_TOOLS,
  ...FINANCE_TOOLS,
  ...OWNER_CUSTOMER_INTEL_TOOLS,
  ...COST_TOOLS,
  ...REMINDER_TOOLS,
  // Two-way live call tool — exposed to the owner-business head via the `base`
  // tool-group, so it must also be executable from the ALMA_LIFESTYLE pool
  // (otherwise the head sees it but a call returns "Unknown tool").
  place_agent_call,
  ...ASK_TOOLS,
  ...ADS_TOOLS,
  ...MARKETING_TOOLS,
  ...LOCATION_TOOLS,
  ...CAMERA_TOOLS,
  ...CATALOG_TOOLS,
  ...WEBSITE_TOOLS,
  ...RESEARCH_TOOLS,
  ...SEO_TOOLS,
  // GA4 analytics (get_ga4_report) — advertised via the `growth` tool-group, so it
  // must be executable here too (the "sees it but Unknown tool" footgun below).
  ...ANALYTICS_TOOLS,
  // Email/SMS campaign drafts (draft_marketing_campaign) — advertised via `growth`,
  // must be executable here (guarded by tool-pool-coverage.test.ts).
  ...CAMPAIGN_TOOLS,
  // Google Business Profile (reviews read + approval-gated reply/post drafts) —
  // advertised via `growth`, must be executable here (pool-coverage test enforces).
  ...GBP_TOOLS,
  // Growth Autopilot calendar tools (schedule_content_batch, configure_growth_autopilot,
  // etc.). Advertised to the head via the `growth` tool-group (tool-groups.ts) — so they
  // MUST also live in this execution pool, otherwise the head sees them but a call returns
  // "Unknown tool" (same footgun the place_agent_call comment above warns about).
  ...GROWTH_TOOLS,
  ...COMPETITOR_TOOLS,
  ...ADVISOR_TOOLS,
  ...OWNER_TODO_TOOLS,
  ...PLAYBOOK_TOOLS,
  ...LEARNING_TOOLS,
  ...REFERENCE_TOOLS,
  ...QC_TOOLS,
  ...VISION_TOOLS,
  ...SIMULATE_TOOLS,
  ...TRYON_TOOLS,
  ...STUDIO_TOOLS,
  ...DIAGNOSTIC_TOOLS,
  ...CONTENT_ENGINE_TOOLS,
  ...COWORKER_TOOLS,
  ...AD_CREATIVE_TOOLS,
  ...VIDEO_TOOLS,
  ...BRAND_TOOLS,
  ...WORK_TODO_TOOLS,
  ...ORCHESTRATOR_TOOLS,
  ...AUTONOMY_TOOLS,
  ...HEARTBEAT_TOOLS,
  ...CS_AUTONOMY_TOOLS,
  ...ORDER_AUTONOMY_TOOLS,
  ...FINANCE_AUTONOMY_TOOLS,
  ...BILLS_TOOLS,
  ...IMPORTANT_DATE_TOOLS,
  ...PERSONAL_BRIEFING_TOOLS,
  ...APPOINTMENT_TOOLS,
  ...HEALTH_TOOLS,
  ...DOCUMENT_TOOLS,
]

// Staff-facing registry: excludes finance, salah, and personal-scope tools.
// Used by any agent call initiated from a staff Telegram channel.
export const STAFF_SAFE_TOOLS: AgentTool[] = [
  get_current_datetime,
  list_agent_projects,
  ...ERP_TOOLS,
  ...CATALOG_TOOLS,
]

/** Tool names exposed to staff-scoped agent contexts (for audits/tests). */
export const STAFF_SAFE_TOOL_NAMES = STAFF_SAFE_TOOLS.map((t) => t.name)

export const TOOL_DEFINITIONS: Anthropic.Messages.Tool[] = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.input_schema,
}))

export const TRADING_TOOL_NAMES = TRADING_TOOLS.map((t) => t.name)

export const TRADING_TOOL_DEFINITIONS: Anthropic.Messages.Tool[] = TRADING_TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.input_schema,
}))

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  serverContext: Record<string, unknown> = {},
): Promise<ToolResult> {
  const businessId = (serverContext.businessId as string | undefined) ?? 'ALMA_LIFESTYLE'
  const conversationId = serverContext.conversationId as string | undefined
  const started = Date.now()
  const pool = businessId === 'ALMA_TRADING' ? TRADING_TOOLS : TOOLS
  const tool = pool.find((t) => t.name === name)
  if (!tool) {
    const anyTool = TOOLS.find((t) => t.name === name)
    if (!anyTool) {
      void logToolEvent({ toolName: name, success: false, errorClass: 'unknown_tool', latencyMs: Date.now() - started, conversationId, businessId })
      return { success: false, error: `Unknown tool: ${name}` }
    }
    if (businessId === 'ALMA_TRADING') {
      void logToolEvent({ toolName: name, success: false, errorClass: 'wrong_business', latencyMs: Date.now() - started, conversationId, businessId })
      return {
        success: false,
        error: `Tool "${name}" Trading registry-এ available নয় — Lifestyle conversation এ চেষ্টা করুন।`,
      }
    }
    const result = await anyTool.handler({ ...input, ...serverContext })
    void logToolEvent({ toolName: name, success: result.success, errorClass: result.success ? undefined : 'handler_error', latencyMs: Date.now() - started, conversationId, businessId })
    return result
  }
  try {
    const result = await tool.handler({ ...input, ...serverContext })
    void logToolEvent({ toolName: name, success: result.success, errorClass: result.success ? undefined : 'handler_error', latencyMs: Date.now() - started, conversationId, businessId })
    return result
  } catch (err) {
    void logToolEvent({ toolName: name, success: false, errorClass: 'uncaught_exception', latencyMs: Date.now() - started, conversationId, businessId })
    return { success: false, error: String(err) }
  }
}
