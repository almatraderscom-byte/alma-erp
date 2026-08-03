import type Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/prisma'
import { embed, vectorLiteral } from '@/agent/lib/embeddings'
import { logToolEvent } from '@/agent/lib/tool-telemetry'
import { actionKey, checkRepeatGuard, repeatGuardMessage } from '@/agent/lib/repeat-guard'
import {
  classifyErrorCode,
  isRetryableErrorCode,
  malformedRawArgsError,
  resolveClassification,
  strictenSchema,
  validateToolInput,
  type ResolvedClassification,
} from './tool-contract'
import { TOOL_CLASSIFICATION } from './capability-classification'
import {
  isToolAllowedForOwnerTurn,
  type OwnerTurnAuthorization,
} from '@/agent/lib/turn-authorization'
import { attachMemoryEmbedding, createOrUpdateAgentMemory } from '@/agent/lib/agent-memory'
import {
  NO_LEXEME_TSQUERY,
  buildLikePatterns,
  buildOrTsQuery,
  extractQueryTokens,
  fuseRrf,
  rawPhrasePatterns,
} from '@/agent/lib/memory-hybrid'
import { ERP_TOOLS } from './erp-tools'
import { CONFIRM_TOOLS } from './confirm-tools'
import { WA_TOOLS } from './wa-tools'
import { find_tool } from './find-tool'
import { STAFF_TOOLS } from './staff-tools'
import { SETTINGS_TOOLS } from './settings-tools'
import { SALAH_TOOLS } from './salah-tools'
import { FINANCE_TOOLS } from './finance-tools'
import { OWNER_CUSTOMER_INTEL_TOOLS } from './cs-tools'
import { CS_AUTONOMY_TOOLS } from './cs-autonomy-tools'
import { ORDER_AUTONOMY_TOOLS } from './order-autonomy-tools'
import { MAC_TOOLS } from './mac-tools'
import { MAC_UI_TOOLS } from './mac-ui-tools'
import { CLI_SESSION_TOOLS } from './cli-session-tools'
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
import { FAMILY_TOOLS, place_agent_call, call_boss_with_report, call_me_in_app } from './personal-tools'
import { place_business_call } from './business-call-tools'
import { PERSONAL_OS_TOOLS } from './personal-os-tools'
import { BUSINESS_OS_TOOLS } from './business-os-tools'
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
import { GRIND_TOOLS } from './grind-tools'
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
import { BROWSER_LOGIN_TOOLS } from './browser-login-tools'
import { BROWSER_LIVE_TOOLS } from './browser-live-tools'
import { BROWSER_RECIPE_TOOLS } from './browser-recipe-tools'
import { NATIVE_PUSH_TOOLS } from './native-push-tools'
import { LIVE_BROWSER_TOOLS } from './live-browser-tools'
import { WORKBENCH_TOOLS } from './workbench-tools'
import { SKILL_PACK_TOOLS } from './skill-pack-tools'
import { SEO_AUDIT_TOOLS } from './seo-audit-tools'
import { ARTIFACT_TOOLS } from './artifact-tools'
import { META_ADS_TOOLS } from './meta-ads-tools'
import { META_ADS_WRITE_TOOLS } from './meta-ads-write-tools'

export interface ToolResult {
  success: boolean
  data?: unknown
  error?: string
  /**
   * Phase 2 result envelope — stable machine error code (see tool-contract.ts
   * TOOL_ERROR_CODES). Handlers may set it themselves; the executor fills it
   * from classifyErrorCode(error) otherwise. Never parse `error` text to decide
   * behavior — key on this.
   */
  errorCode?: string
  /**
   * Phase 2 result envelope — true when the SAME call may succeed if simply
   * retried (timeout / rate-limit / network / provider 5xx). The executor
   * derives it from errorCode unless the handler set it explicitly.
   */
  retryable?: boolean
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

    /**
     * Hybrid recall (Codex P2, PR #711). This handler used to run a vector-only
     * query, so the exact identifiers the hybrid work targets — ORD-123, a phone
     * number, a product code — were still missed on the path the head actually
     * uses when it deliberately looks something up. It now runs the same two arms
     * as the per-turn retrieval and fuses them with RRF, keeping this tool's own
     * business filtering and its 0.45 semantic floor.
     *
     * Expired facts are excluded here too: neither branch used to filter them, so
     * a day-scoped fact ("আজ অফিস ছুটি") could be served as if still standing.
     */
    const liveFactsOnly = `AND (expires_at IS NULL OR expires_at > NOW())`
    const tokens = extractQueryTokens(query)

    try {
      const embedResult = await embed(query)
      const vec = embedResult.success ? vectorLiteral(embedResult.data) : null
      // Fetch deeper than `limit` per arm so the fusion has something to work with.
      const fetchDepth = limit * 3

      type Row = {
        id: string; scope: string; key: string | null; content: string
        pinned: boolean; created_at: Date; score: number
      }

      const [vectorRows, keywordRows] = await Promise.all([
        vec
          ? // scope is parameterized ($3) — never interpolated — to prevent SQL injection.
            ((prisma as any).$queryRawUnsafe(
              `SELECT id, scope, key, content, pinned, "createdAt" AS created_at,
                      1 - (embedding <=> $1::vector) AS score
               FROM agent_memory
               WHERE embedding IS NOT NULL ${liveFactsOnly} ${scope ? `AND scope = $3` : ''} ${businessFilterClause}
               ORDER BY embedding <=> $1::vector
               LIMIT $2`,
              ...(scope ? [vec, fetchDepth, scope] : [vec, fetchDepth]),
            ) as Promise<Row[]>)
          : Promise.resolve<Row[]>([]),
        // scope is parameterized ($4) for the same reason.
        ((prisma as any).$queryRawUnsafe(
          `SELECT id, scope, key, content, pinned, "createdAt" AS created_at,
                  ts_rank(to_tsvector('simple', content), to_tsquery('simple', $1)) AS score
           FROM agent_memory
           WHERE (to_tsvector('simple', content) @@ to_tsquery('simple', $1)
                  OR content ILIKE ANY($2::text[]))
             ${liveFactsOnly} ${scope ? `AND scope = $4` : ''} ${businessFilterClause}
           ORDER BY score DESC, "createdAt" DESC
           LIMIT $3`,
          ...(scope
            ? [tokens.length > 0 ? buildOrTsQuery(tokens) : NO_LEXEME_TSQUERY,
               tokens.length > 0 ? buildLikePatterns(tokens) : rawPhrasePatterns(query),
               fetchDepth, scope]
            : [tokens.length > 0 ? buildOrTsQuery(tokens) : NO_LEXEME_TSQUERY,
               tokens.length > 0 ? buildLikePatterns(tokens) : rawPhrasePatterns(query),
               fetchDepth]),
        ) as Promise<Row[]>),
      ])

      const byId = new Map<string, Row>()
      const semanticScore = new Map<string, number>()

      const vectorHits = vectorRows
        .filter((r) => r.score >= 0.45)
        .map((row, rank) => {
          byId.set(row.id, row)
          semanticScore.set(row.id, row.score)
          return { id: row.id, rank }
        })
      const keywordHits = keywordRows.map((row, rank) => {
        if (!byId.has(row.id)) byId.set(row.id, row)
        return { id: row.id, rank }
      })

      const results = fuseRrf([vectorHits, keywordHits])
        .slice(0, limit)
        .map((hit) => {
          const row = byId.get(hit.id)
          if (!row) return null
          const semantic = semanticScore.get(hit.id)
          return {
            id: row.id, scope: row.scope, key: row.key, content: row.content,
            pinned: row.pinned,
            // Semantic similarity when we have it; a keyword-only hit reports
            // null, exactly as the old text fallback did.
            score: semantic != null ? Math.round(semantic * 100) / 100 : null,
          }
        })
        .filter((r): r is NonNullable<typeof r> => r !== null)

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
  // B6 — "আর জিজ্ঞেস কোরো না" happens in personal chats too, and the tools
  // that answer it are an approval card and its cancel button; withholding
  // them here left the personal head able only to describe the problem.
  ...AUTONOMY_TOOLS.filter((t) => t.name === 'request_standing_permission' || t.name === 'revoke_standing_permission'),
]

export const PERSONAL_SAFE_TOOL_NAMES = PERSONAL_SAFE_TOOLS.map((t) => t.name)

/**
 * Phase 2 Tool Contract: harden every tool's input schema IN PLACE (root
 * `additionalProperties: false`) before any model-facing definitions are derived,
 * so the model is shown exactly the strict contract the executor enforces.
 * Tool objects are shared across pools/groups, so hardening a pool also hardens
 * its tools everywhere else; strictenSchema is idempotent.
 */
export function hardenToolSchemas(tools: AgentTool[]): AgentTool[] {
  for (const t of tools) {
    t.input_schema = strictenSchema(t.input_schema) as AgentTool['input_schema']
  }
  return tools
}

hardenToolSchemas(PERSONAL_SAFE_TOOLS)

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
  if (!tool) {
    return { success: false, error: `Unknown personal tool: ${name}`, errorCode: 'unknown_tool', retryable: false }
  }
  return runRegisteredTool(tool, input, serverContext, {
    conversationId: serverContext.conversationId as string | undefined,
    businessId: (serverContext.businessId as string | undefined) ?? 'ALMA_LIFESTYLE',
    turnId: serverContext.turnId as string | undefined,
    turnAuthorization: serverContext.turnAuthorization as OwnerTurnAuthorization | undefined,
    // The personal toolbox is not exempt from the mode. Without this, Plan let a
    // routine personal write (`add_bill`) execute on the native loop — the one
    // promise Plan makes is that nothing changes (review bot, #667).
    permissionMode: serverContext.permissionMode as string | undefined,
    elevationGrant: serverContext.elevationGrant as ToolRunContext['elevationGrant'],
  })
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
  ...BROWSER_LOGIN_TOOLS,
  ...BROWSER_LIVE_TOOLS,
  ...BROWSER_RECIPE_TOOLS,
  ...NATIVE_PUSH_TOOLS,
  ...LIVE_BROWSER_TOOLS,
  ...WORKBENCH_TOOLS,
  // M1 — the owner's own Mac. Sits with the other computer-use tools so any
  // chat can reach it ("Mac-e test chalao") without a keyword unlocking a group.
  ...MAC_TOOLS,
  // M2 — Claude/Codex sessions driven on that same Mac.
  ...CLI_SESSION_TOOLS,
  // L8 (W4) — driving the allowlisted desktop apps (Claude, ChatGPT) on that Mac.
  ...MAC_UI_TOOLS,
  ...SKILL_PACK_TOOLS,
  ...SEO_AUDIT_TOOLS,
  ...ARTIFACT_TOOLS,
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
  ...GRIND_TOOLS,
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
  // In-app live call to Boss (plan C1/C2) — the default when Boss says "কল দাও".
  call_me_in_app,
  // PA-5R human-PA callback — boss-requested completion call, no card.
  call_boss_with_report,
  // Human-PA point 2 — order-aware customer call (delegates dialing to place_agent_call).
  place_business_call,
  ...ASK_TOOLS,
  // Harness gap 5 — registry-wide tool discovery (dynamic schema load per turn).
  find_tool,
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
  // Meta Ads MCP bridged reads (Phase MA1) — advertised via `growth`, so they
  // must be executable here (same sees-it-but-Unknown-tool footgun as above).
  ...META_ADS_TOOLS,
  // Meta Ads MCP write tools (Phase MA3) — staged behind approval cards; inert
  // at read tier (writeGate). Executable here so a call resolves post-approval.
  ...META_ADS_WRITE_TOOLS,
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
  ...GRIND_TOOLS,
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
  // Phase 66: Personal/Business OS adapter tools — reachable by the head now
  // (GAP-06). read + private-stage only; they refuse gracefully when the named
  // adapter is not connected, so exposure is safe before any bootstrap.
  ...PERSONAL_OS_TOOLS,
  ...BUSINESS_OS_TOOLS,
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

hardenToolSchemas(TOOLS)
hardenToolSchemas(TRADING_TOOLS)
hardenToolSchemas(STAFF_SAFE_TOOLS)

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

/** Telemetry context for one tool execution. */
interface ToolRunContext {
  conversationId?: string
  businessId?: string
  turnId?: string
  /** PM-1 — the permission mode this call ran under. Recorded, not yet enforced. */
  permissionMode?: string
  /** B6 — a live, family-scoped grant. Read alongside the mode, never instead. */
  elevationGrant?: import('@/agent/lib/permission-mode').ElevationGrant | null
  surface?: 'owner' | 'cs' | 'scheduler'
  turnAuthorization?: OwnerTurnAuthorization
  driveClientSeoBatch?: boolean
  /**
   * Phase 52 guard context — explicit instruction origin (heartbeat/autodrive/
   * browser callers set this; surfaces derive a default), an approval envelope
   * when executing an approved action, and caller-known scope flags.
   */
  instructionOrigin?: 'owner_direct' | 'owner_policy' | 'model_initiative' | 'external_content'
  approvalEnvelope?: import('@/agent/lib/policy/capability-token').SignedEnvelope
  confidence?: number
  capabilityRevoked?: boolean
  accountScopeOk?: boolean
}

function classificationFor(name: string): ResolvedClassification {
  // Unclassified = treated as a medium-risk write until an entry is authored
  // (capability-manifest.test.ts fails CI on any missing entry, so this fallback
  // only ever runs for a tool added in the same commit that forgot the manifest).
  const authored = TOOL_CLASSIFICATION[name] ?? { domain: 'unclassified', mode: 'write' as const, risk: 'medium' as const }
  return resolveClassification(authored)
}

/**
 * Phase 2 validated executor — the ONE path every registered tool call goes
 * through (owner, trading, personal, and CS surfaces):
 *
 *   1. Validate model-generated args against the tool's strict schema (Ajv,
 *      Draft-7, root additionalProperties:false). Invalid args NEVER reach the
 *      handler — the model gets an actionable `invalid_args` envelope instead.
 *   2. Run the handler with server context merged in (server context wins on
 *      key collisions and is deliberately NOT part of the validated surface).
 *   3. Finalize the result envelope: stable `errorCode` (handler-declared or
 *      classified from the error text) + `retryable`.
 *   4. Log the telemetry span with capability labels.
 */
/**
 * Phase 64: feed a real agent-initiated effect outcome back to the autonomy
 * ladder — one readiness sample + auto-rollback bookkeeping. Fire-and-forget;
 * never blocks or throws into the tool path. This is what makes the readiness /
 * SLO tables receive live class-scoped rows once a class leaves 'off'.
 */
async function feedLadderOutcome(taskClass: string, ok: boolean): Promise<void> {
  try {
    const [{ recordReadinessEvidence }, { recordRolloutOutcome }] = await Promise.all([
      import('@/agent/lib/autonomy-readiness'),
      import('@/agent/lib/autonomy-rollout'),
    ])
    await recordReadinessEvidence(taskClass, { samples: 1, correct: ok ? 1 : 0 })
    await recordRolloutOutcome(taskClass, { ok })
  } catch (err) {
    console.warn('[registry] ladder outcome feed failed:', err instanceof Error ? err.message : err)
  }
}

export async function runRegisteredTool(
  tool: AgentTool,
  input: Record<string, unknown>,
  serverContext: Record<string, unknown>,
  ctx: ToolRunContext,
): Promise<ToolResult> {
  const started = Date.now()
  const cap = classificationFor(tool.name)
  const baseEvent = {
    surface: ctx.surface,
    toolName: tool.name,
    conversationId: ctx.conversationId,
    businessId: ctx.businessId,
    turnId: ctx.turnId,
  }
  // P0-4: a stable key for THIS attempt (tool + significant arguments), written
  // on every event so "the same call already failed twice" is a query, not a
  // guess. See repeat-guard.ts.
  const argsKey = actionKey(tool.name, input)
  const capDetail = {
    domain: cap.domain,
    mode: cap.mode,
    risk: cap.risk,
    argsKey,
    ...(ctx.permissionMode ? { permissionMode: ctx.permissionMode } : {}),
  }

  if (!isToolAllowedForOwnerTurn(tool.name, ctx.turnAuthorization)) {
    void logToolEvent({
      ...baseEvent,
      success: false,
      errorClass: 'turn_authorization',
      errorCode: 'turn_read_only',
      latencyMs: Date.now() - started,
      detail: { ...capDetail, authorization: ctx.turnAuthorization?.reason, execution: 'rejected' },
    })
    return {
      success: false,
      error:
        'Boss-এর original message শুধু তথ্য/স্ট্যাটাস চেয়েছে—কোনো পরিবর্তনের অনুমতি দেয়নি। ' +
        `তাই ${tool.name} server থেকে block করা হয়েছে। read tool দিয়ে উত্তর দিন; পরিবর্তন দরকার হলে Boss-এর explicit instruction চান।`,
      errorCode: 'turn_read_only',
      retryable: false,
    }
  }

  // P0-4 — the same mistake, twice. Boss's complaint was not that a call
  // failed; it was that he corrected it and it did the same thing again.
  // Everything meant to prevent that is advisory (the failure is explained in
  // TEXT and the model decides whether to differ), and under a model switch or
  // a long transcript that goodwill is exactly what evaporates. The THIRD
  // identical non-retryable attempt is refused here, in code.
  const repeat = await checkRepeatGuard({
    toolName: tool.name,
    argsKey,
    conversationId: ctx.conversationId,
  })
  if (repeat.blocked) {
    void logToolEvent({
      ...baseEvent,
      success: false,
      errorClass: 'repeat_guard',
      errorCode: 'repeat_blocked',
      latencyMs: Date.now() - started,
      detail: { ...capDetail, priorFailures: repeat.priorFailures, execution: 'rejected', repeatable: true },
    })
    return {
      success: false,
      error: repeatGuardMessage(tool.name, repeat),
      errorCode: 'repeat_blocked',
      retryable: false,
    }
  }

  // PM-5 — the permission mode, ENFORCED here rather than only recorded.
  //
  // The head applies the mode before it calls a tool, so for a head turn this is
  // a second look that changes nothing. A delegated specialist has no such step:
  // forwarding the mode string would leave a worker free to write under Plan and
  // to change things silently under Careful, which is the bypass PM-5 exists to
  // close. Only the two verdicts the head would never reach are blocked, so this
  // cannot narrow existing head behaviour:
  //   • plan   → anything above a pure read is absent, not merely gated
  //   • careful→ an ordinary R1/R2 write belongs on a card, and only the head
  //              can stage one, so the worker must hand it back.
  // Taking a permission AWAY is safe in every mode — gating it would trap Boss
  // inside a grant he just asked to end (review bot, #667).
  const MODE_EXEMPT_TOOLS = new Set(['revoke_standing_permission'])
  if (ctx.permissionMode && !MODE_EXEMPT_TOOLS.has(tool.name)) {
    try {
      const { modeVerdict, normalizePermissionMode } = await import('@/agent/lib/permission-mode')
      const { taskClassForTool } = await import('@/agent/lib/autonomy-task-catalog')
      const mode = normalizePermissionMode(ctx.permissionMode)
      const task = taskClassForTool(tool.name, cap)
      // Only an EXPLICIT tool→family mapping may be lifted by a grant, and only
      // one the ROW still confirms — a worker's snapshot can outlive a revoke.
      let grantForVerdict = task.explicit ? ctx.elevationGrant ?? null : null
      if (grantForVerdict) {
        const { confirmGrantStillCovers } = await import('@/agent/lib/standing-grant')
        if (!(await confirmGrantStillCovers(ctx.conversationId, task.taskClass))) grantForVerdict = null
      }
      const verdict = modeVerdict({
        mode,
        tier: task.tier,
        taskClass: task.taskClass,
        grant: grantForVerdict,
        now: Date.now(),
      })
      const blockedByMode =
        verdict === 'blocked'
        || (verdict === 'card' && mode === 'careful' && cap.mode === 'write')
      if (blockedByMode) {
        void logToolEvent({
          ...baseEvent,
          success: false,
          errorClass: 'permission_mode',
          errorCode: 'permission_mode_blocked',
          latencyMs: Date.now() - started,
          detail: { ...capDetail, tier: task.tier, taskClass: task.taskClass, verdict, execution: 'rejected' },
        })
        return {
          success: false,
          error:
            mode === 'plan'
              ? `প্ল্যান মোড চলছে — এই মোডে কিছুই বদলানো যাবে না, তাই ${tool.name} চালানো হয়নি। পড়ার কাজ করো, আর কী করতে চাও সেটা লিখে দাও।`
              : `সতর্ক মোড চলছে — ${tool.name} নিজে চালানো যাবে না, Boss-এর approval কার্ডে যেতে হবে। কাজটা head-কে ফেরত দাও, ও কার্ড বানাবে।`,
          errorCode: 'permission_mode_blocked',
          retryable: false,
        }
      }
    } catch (err) {
      // A mode we cannot resolve must not break the call — the guard below and
      // the head's own check still apply.
      console.warn('[registry] permission-mode check failed open:', err instanceof Error ? err.message : err)
    }
  }

  // Streamed tool args that failed JSON.parse arrive as the `{ _raw }` marker.
  // Short-circuit with a self-repair error that ECHOES the broken text back, so
  // the model fixes its own emission — instead of the misleading schema error
  // (`unknown field "_raw"`) this used to fall through to. retryable: the model
  // gets another loop round to re-call correctly.
  const malformed = malformedRawArgsError(input)
  if (malformed) {
    void logToolEvent({
      ...baseEvent,
      success: false,
      errorClass: 'malformed_args',
      errorCode: 'malformed_args',
      latencyMs: Date.now() - started,
      detail: { ...capDetail, argsValidation: 'unparseable' },
    })
    return { success: false, error: malformed, errorCode: 'malformed_args', retryable: true }
  }

  const validation = validateToolInput(tool.name, tool.input_schema, input ?? {})
  if (!validation.ok) {
    void logToolEvent({
      ...baseEvent,
      success: false,
      errorClass: 'invalid_args',
      errorCode: 'invalid_args',
      latencyMs: Date.now() - started,
      detail: { ...capDetail, argsValidation: 'rejected' },
    })
    return { success: false, error: validation.error, errorCode: 'invalid_args', retryable: false }
  }

  // Phase 5 workflow guards — the incident HARD RULEs enforced in code (preview
  // confirm before post, real product reference, no delegate mid-pipeline,
  // repeated-navigation protection). Small named tool set; fails open on errors,
  // blocks only on a POSITIVE invariant violation with a self-recoverable
  // Bangla instruction. Dynamic import keeps the lib→tools layering acyclic.
  if (ctx.conversationId) {
    try {
      const wg = await import('@/agent/lib/workflow-guards')
      if (wg.WORKFLOW_GUARDED_TOOLS.has(tool.name)) {
        const block = await wg.checkWorkflowGuards(tool.name, input ?? {}, ctx)
        if (block) {
          void logToolEvent({
            ...baseEvent,
            success: false,
            errorClass: 'workflow_blocked',
            errorCode: 'workflow_blocked',
            latencyMs: Date.now() - started,
            detail: { ...capDetail, argsValidation: 'passed', guard: block.guard },
          })
          return { success: false, error: block.error, errorCode: 'workflow_blocked', retryable: false }
        }
      }
    } catch (err) {
      console.warn('[registry] workflow guard failed open:', err instanceof Error ? err.message : err)
    }
  }

  // Phase 52 universal tool guard — EVERY registered tool call on every surface
  // passes through the deterministic policy kernel. Hard constitutional
  // violations (untrusted-content instructions, stale approvals, same-turn
  // duplicates, R4 owner-only, money-cap breaches, out-of-scope accounts) are
  // BLOCKED; ladder decisions (point-of-risk staging for owner-direct R3
  // writes, bounded-policy proposals) are shadow-logged until Phase 57 promotes
  // them per task class. Fail-closed for effects, fail-open for reads.
  let guardEnvelope: import('@/agent/lib/policy/capability-token').SignedEnvelope | undefined
  // Phase 64: the autonomy ladder task class this call maps to (agent-initiated
  // effects only), captured so the outcome can be fed back after execution.
  let ladderTaskClass: string | undefined
  // The duplicate-suppression key this call claimed, if any. An allowed call is
  // NOT a completed effect: if the handler fails, the claim must be handed back
  // or an identical legitimate retry is refused as a duplicate for 10 minutes
  // (owner incident 2026-07-26 — draft_seo_fixes staged nothing, then "একই কাজ
  // এই টার্নে আগেই হয়েছে").
  let claimedKey: string | undefined
  const releaseClaimOnFailure = async () => {
    if (!claimedKey) return
    const key = claimedKey
    claimedKey = undefined
    try {
      const { releaseEffectClaim } = await import('@/agent/lib/policy/tool-guard')
      releaseEffectClaim(key)
    } catch (err) {
      console.warn('[registry] claim release failed:', err instanceof Error ? err.message : err)
    }
  }
  {
    const { guardToolCall } = await import('@/agent/lib/policy/tool-guard')
    // Does the owner's standing grant name THIS call's family? Explicit mappings
    // only — a fallback class is a risk floor, not a family.
    let standingGrantCoversCall = false
    if (ctx.elevationGrant) {
      try {
        const { isFamilyGrantLive } = await import('@/agent/lib/permission-mode')
        const { taskClassForTool } = await import('@/agent/lib/autonomy-task-catalog')
        const task = taskClassForTool(tool.name, cap)
        standingGrantCoversCall =
          task.explicit && isFamilyGrantLive(ctx.elevationGrant, task.taskClass, Date.now())
        // A delegated worker holds the grant it was handed at the start and can
        // run for a while; a revoke or mode change meanwhile must bite here, at
        // the one door every tool call passes through.
        if (standingGrantCoversCall) {
          const { confirmGrantStillCovers } = await import('@/agent/lib/standing-grant')
          standingGrantCoversCall = await confirmGrantStillCovers(ctx.conversationId, task.taskClass)
        }
      } catch {
        standingGrantCoversCall = false
      }
    }
    const guard = await guardToolCall(tool.name, input ?? {}, cap, {
      standingGrantCoversCall,
      surface: ctx.surface,
      conversationId: ctx.conversationId,
      businessId: ctx.businessId,
      turnId: ctx.turnId,
      instructionOrigin: ctx.instructionOrigin,
      approvalEnvelope: ctx.approvalEnvelope,
      confidence: ctx.confidence,
      capabilityRevoked: ctx.capabilityRevoked,
      accountScopeOk: ctx.accountScopeOk,
    })
    ladderTaskClass = guard.ladderTaskClass
    if (guard.action === 'block') {
      void logToolEvent({
        ...baseEvent,
        success: false,
        errorClass: 'guard_blocked',
        errorCode: guard.errorCode ?? 'guard_blocked',
        latencyMs: Date.now() - started,
        detail: {
          ...capDetail,
          argsValidation: 'passed',
          guardDecision: guard.decision.decision,
          guardReason: guard.decision.reasonClass,
          guardTier: guard.decision.riskTier,
          guardEnforced: true,
          ladderTaskClass: guard.ladderTaskClass,
          ladderStage: guard.ladderStage,
          ladderVerdict: guard.ladderVerdict,
          ladderEnforced: guard.ladderEnforced,
        },
      })
      // A ladder-enforced block IS a real class-scoped outcome — record it so
      // the SLO/readiness tables receive live rows (Phase 64 exit gate).
      if (guard.ladderEnforced && guard.ladderTaskClass) {
        void feedLadderOutcome(guard.ladderTaskClass, false)
      }
      return { success: false, error: guard.error, errorCode: guard.errorCode ?? 'guard_blocked', retryable: false }
    }
    guardEnvelope = guard.envelope
    claimedKey = guard.claimedKey
    // Shadow observability: when the constitution wanted a stricter path than
    // we enforce today, record it — Phase 57 readiness is computed from these.
    if (!guard.enforced || guard.ladderStage) {
      void logToolEvent({
        ...baseEvent,
        success: true,
        latencyMs: 0,
        detail: {
          ...capDetail,
          guardDecision: guard.decision.decision,
          guardReason: guard.decision.reasonClass,
          guardTier: guard.decision.riskTier,
          guardEnforced: guard.enforced,
          guardShadow: !guard.enforced,
          ladderTaskClass: guard.ladderTaskClass,
          ladderStage: guard.ladderStage,
          ladderVerdict: guard.ladderVerdict,
        },
      })
    }
  }

  try {
    const handlerContext = { ...serverContext }
    delete handlerContext.turnAuthorization

    // PM-5 — the turn's own rules, in one place a delegating tool can forward.
    // `turnAuthorization` is stripped above so it never reaches a handler as a
    // stray argument; a tool that spawns a sub-agent still has to pass it on, or
    // the worker runs outside the read-only turn, the permission mode and the
    // same-turn duplicate guard that bind the head.
    handlerContext.delegatedToolContext = {
      ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
      ...(ctx.permissionMode ? { permissionMode: ctx.permissionMode } : {}),
      ...(ctx.turnAuthorization ? { turnAuthorization: ctx.turnAuthorization } : {}),
      ...(ctx.instructionOrigin ? { instructionOrigin: ctx.instructionOrigin } : {}),
      ...(ctx.elevationGrant ? { elevationGrant: ctx.elevationGrant } : {}),
    }

    // Phase 53/65: route direct write effects through the exactly-once effect
    // engine (durable run + append-only ledger; ledger failure BLOCKS the write
    // — there is NO direct-handler fallback). Phase 65 replaces the binary
    // all-writes flip with a master switch + per-task-class canary so ONE R1
    // class can pilot the engine. Selection is computed once here.
    const effectSel = cap.mode === 'write' && guardEnvelope
      ? (await import('@/agent/lib/effects/action-run')).effectEngineSelectionFromEnv(
          'write',
          (await import('@/agent/lib/autonomy-task-catalog')).taskClassForTool(tool.name, cap).taskClass,
        )
      : { use: false, reason: 'not_eligible' }
    if (effectSel.use && cap.mode === 'write' && guardEnvelope) {
      const { executeEffect } = await import('@/agent/lib/effects/action-run')
      const outcome = await executeEffect({
        envelope: guardEnvelope,
        input: input ?? {},
        execute: async () => {
          const r = await tool.handler({ ...input, ...handlerContext })
          return { success: r.success, data: r.data, error: r.error, errorCode: r.errorCode, retryable: r.retryable }
        },
      })
      const effectResult: ToolResult = outcome.ok
        ? { success: true, data: outcome.result }
        : { success: false, error: outcome.error, errorCode: outcome.errorCode ?? 'effect_failed', retryable: outcome.state === 'failed_retryable' }
      if (!effectResult.success) await releaseClaimOnFailure()
      void logToolEvent({
        ...baseEvent,
        success: effectResult.success,
        errorCode: effectResult.success ? undefined : effectResult.errorCode,
        latencyMs: Date.now() - started,
        detail: { ...capDetail, argsValidation: 'passed', effectEngine: true, effectSelection: effectSel.reason, effectState: outcome.state, effectReplayed: outcome.replayed },
      })
      if (ladderTaskClass) void feedLadderOutcome(ladderTaskClass, effectResult.success)
      return effectResult
    }

    const result = await tool.handler({ ...input, ...handlerContext })
    // Phase 64: feed the real outcome back to the autonomy ladder (agent-
    // initiated effects only — ladderTaskClass is unset otherwise).
    if (ladderTaskClass) void feedLadderOutcome(ladderTaskClass, result.success)
    if (result.success) {
      void logToolEvent({
        ...baseEvent,
        success: true,
        latencyMs: Date.now() - started,
        detail: { ...capDetail, argsValidation: 'passed' },
      })
      // Phase 5 post-hook: successful get_product / extract_invoice / live
      // browser calls feed the workflow state machine (facts, session state,
      // doc_extraction run). Fire-and-forget, never blocks the reply.
      if (ctx.conversationId) {
        // Ordered client-SEO is durable control state. Await this hook so the
        // next model round sees the newly legal step; fire-and-forget created a
        // race where report/site-2 routing read stale state.
        if (
          ctx.driveClientSeoBatch
          && (
            tool.name === 'live_browser_act'
            || tool.name === 'live_browser_look'
            || tool.name === 'run_website_seo_audit'
            || tool.name === 'check_website_seo_audit'
            || tool.name === 'complete_skill_pack_run'
          )
        ) {
          try {
            const batch = await import('@/agent/lib/client-seo-batch')
            await batch.recordClientSeoBatchTool(ctx.conversationId, tool.name, input ?? {}, result.data)
          } catch (err) {
            console.warn('[registry] client SEO workflow hook failed:', err instanceof Error ? err.message : err)
          }
        }
        void import('@/agent/lib/workflow-guards')
          .then((wg) =>
            wg.WORKFLOW_HOOKED_TOOLS.has(tool.name)
              ? wg.onWorkflowToolExecuted(tool.name, input ?? {}, result.data, ctx)
              : undefined,
          )
          .catch(() => {})
      }
      return result
    }
    // The handler said no — nothing was staged, nothing was written. Hand the
    // duplicate-suppression key back so the head's corrected (or identical)
    // retry is judged on its own merits.
    await releaseClaimOnFailure()
    // Failed live-browser act → record it so the §H navigation guard permits a
    // retry of the same target (fail-open bookkeeping).
    if (ctx.conversationId && tool.name === 'live_browser_act') {
      void import('@/agent/lib/workflow-guards')
        .then((wg) => wg.onWorkflowToolFailed(tool.name, input ?? {}, ctx))
        .catch(() => {})
    }
    const errorCode = result.errorCode ?? classifyErrorCode(result.error)
    const retryable = result.retryable ?? isRetryableErrorCode(errorCode)
    void logToolEvent({
      ...baseEvent,
      success: false,
      errorClass: 'handler_error',
      errorCode,
      latencyMs: Date.now() - started,
      // `repeatable` exempts this failure from the repeat guard: a timeout is
      // the network's fault, and refusing to retry it would be its own bug.
      detail: { ...capDetail, argsValidation: 'passed', repeatable: retryable, lastError: result.error ?? null },
    })
    return { ...result, errorCode, retryable }
  } catch (err) {
    await releaseClaimOnFailure()
    const errorCode = classifyErrorCode(String(err))
    const thrownRetryable = isRetryableErrorCode(errorCode)
    void logToolEvent({
      ...baseEvent,
      success: false,
      errorClass: 'uncaught_exception',
      errorCode,
      latencyMs: Date.now() - started,
      // Same marker the returned-failure path writes: without it a thrown
      // timeout counted toward the repeat guard and the third honest retry was
      // refused (review bot, #692).
      detail: { ...capDetail, argsValidation: 'passed', repeatable: thrownRetryable, lastError: String(err).slice(0, 300) },
    })
    return { success: false, error: String(err), errorCode, retryable: thrownRetryable }
  }
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  serverContext: Record<string, unknown> = {},
): Promise<ToolResult> {
  const businessId = (serverContext.businessId as string | undefined) ?? 'ALMA_LIFESTYLE'
  const conversationId = serverContext.conversationId as string | undefined
  const turnId = serverContext.turnId as string | undefined
  const pool = businessId === 'ALMA_TRADING' ? TRADING_TOOLS : TOOLS
  let tool = pool.find((t) => t.name === name)
  if (!tool) {
    const anyTool = TOOLS.find((t) => t.name === name)
    if (!anyTool) {
      void logToolEvent({ toolName: name, success: false, errorClass: 'unknown_tool', errorCode: 'unknown_tool', latencyMs: 0, conversationId, businessId, turnId })
      return { success: false, error: `Unknown tool: ${name}`, errorCode: 'unknown_tool', retryable: false }
    }
    if (businessId === 'ALMA_TRADING') {
      void logToolEvent({ toolName: name, success: false, errorClass: 'wrong_business', errorCode: 'wrong_business', latencyMs: 0, conversationId, businessId, turnId })
      return {
        success: false,
        error: `Tool "${name}" Trading registry-এ available নয় — Lifestyle conversation এ চেষ্টা করুন।`,
        errorCode: 'wrong_business',
        retryable: false,
      }
    }
    tool = anyTool
  }
  return runRegisteredTool(tool, input, serverContext, {
    conversationId,
    businessId,
    turnId,
    permissionMode: typeof serverContext.permissionMode === 'string' ? serverContext.permissionMode : undefined,
    elevationGrant: (serverContext.elevationGrant as ToolRunContext['elevationGrant']) ?? null,
    turnAuthorization: serverContext.turnAuthorization as OwnerTurnAuthorization | undefined,
    driveClientSeoBatch: serverContext.driveClientSeoBatch === true,
    instructionOrigin: serverContext.instructionOrigin as ToolRunContext['instructionOrigin'],
    approvalEnvelope: serverContext.approvalEnvelope as ToolRunContext['approvalEnvelope'],
    confidence: typeof serverContext.confidence === 'number' ? serverContext.confidence : undefined,
    capabilityRevoked: serverContext.capabilityRevoked === true,
    accountScopeOk: serverContext.accountScopeOk === false ? false : undefined,
  })
}

// Back-compat re-exports — the contract layer now owns these (tool-contract.ts).
export { classifyErrorCode, isRetryableErrorCode } from './tool-contract'
