import type Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/prisma'
import { embed, vectorLiteral } from '@/agent/lib/embeddings'
import { attachMemoryEmbedding, createOrUpdateAgentMemory } from '@/agent/lib/agent-memory'
import { ERP_TOOLS } from './erp-tools'
import { CONFIRM_TOOLS } from './confirm-tools'
import { STAFF_TOOLS } from './staff-tools'
import { SETTINGS_TOOLS } from './settings-tools'
import { SALAH_TOOLS } from './salah-tools'
import { FINANCE_TOOLS } from './finance-tools'
import { OWNER_CUSTOMER_INTEL_TOOLS } from './cs-tools'
import { COST_TOOLS } from './cost-tools'
import { REMINDER_TOOLS } from './reminder-tools'
import { ASK_TOOLS } from './ask-tools'
import { ADS_TOOLS } from './ads-tools'
import { LOCATION_TOOLS } from './location-tools'
import { CATALOG_TOOLS } from './catalog-tools'
import { WEBSITE_TOOLS } from './website-tools'
import { RESEARCH_TOOLS } from './research-tools'
import { SEO_TOOLS } from './seo-tools'
import { COMPETITOR_TOOLS } from './competitor-tools'
import { ADVISOR_TOOLS } from './advisor-tools'
import { FAMILY_TOOLS } from './personal-tools'
import { OWNER_TODO_TOOLS } from './owner-todo-tools'
import { TRYON_TOOLS } from './tryon-tools'
import { DIAGNOSTIC_TOOLS } from './diagnostic-tools'
import { CONTENT_ENGINE_TOOLS } from './content-engine-tools'
import { AD_CREATIVE_TOOLS } from './ad-creative-tools' // make_ad_creatives
import { VIDEO_TOOLS } from './video-tools' // make_product_reel
import { BRAND_TOOLS } from './brand-tools'
import { TRADING_READ_TOOLS } from './trading-tools'
import { PLAYBOOK_TOOLS } from './playbook-tools'

export interface ToolResult {
  success: boolean
  data?: unknown
  error?: string
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
    'Saves a durable fact to long-term memory with semantic embedding. Use when the owner states a preference, business fact, person, or recurring pattern. Trigger phrase: "মনে রাখো…". Use scope=business + key (e.g. contact_phone, contact_website) + pinned=true for standing contact info. Never save secrets or API keys. Business scope (Lifestyle vs Trading) is auto-tagged from server context.',
  input_schema: {
    type: 'object' as const,
    properties: {
      scope: { type: 'string', enum: ['personal', 'business', 'staff'], description: 'Memory scope' },
      key: { type: 'string', description: 'Optional short identifier for the fact' },
      content: { type: 'string', description: 'The fact to remember (clear, self-contained text)' },
      pinned: { type: 'boolean', description: 'If true, this fact is injected into every conversation system prompt (use for critical standing facts, cap 30)' },
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

    try {
      const mem = await createOrUpdateAgentMemory({ scope, key, content, pinned, metadata })
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

    /**
     * Business filter: Trading context should NOT see Lifestyle-tagged memories
     * (and vice versa). Personal-scope memories are cross-business (no filter).
     * Untagged legacy memories default to ALMA_LIFESTYLE — included only when
     * the current context is ALMA_LIFESTYLE.
     */
    const businessFilterClause =
      scope === 'personal'
        ? ''
        : businessId === 'ALMA_TRADING'
          ? `AND (metadata->>'businessId' = 'ALMA_TRADING')`
          : `AND (metadata->>'businessId' IS NULL OR metadata->>'businessId' = 'ALMA_LIFESTYLE')`

    try {
      const embedResult = await embed(query)
      if (!embedResult.success) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rows: Array<{ id: string; scope: string; key: string|null; content: string; pinned: boolean; created_at: Date }> =
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (prisma as any).$queryRawUnsafe(
            `SELECT id, scope, key, content, pinned, created_at
             FROM agent_memory
             WHERE content ILIKE $1
               ${scope ? `AND scope = $2` : ''}
               ${businessFilterClause}
             ORDER BY created_at DESC
             LIMIT ${limit}`,
            ...(scope ? [`%${query}%`, scope] : [`%${query}%`]),
          )
        return {
          success: true,
          data: rows.map((r) => ({ ...r, businessId, score: null })),
        }
      }

      const vec = vectorLiteral(embedResult.data)
      const scopeClause = scope ? `AND scope = '${scope}'` : ''
      const rows: Array<{ id: string; scope: string; key: string|null; content: string; pinned: boolean; created_at: Date; score: number }> =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (prisma as any).$queryRawUnsafe(
          `SELECT id, scope, key, content, pinned, created_at,
                  1 - (embedding <=> $1::vector) AS score
           FROM agent_memory
           WHERE embedding IS NOT NULL ${scopeClause} ${businessFilterClause}
           ORDER BY embedding <=> $1::vector
           LIMIT $2`,
          vec,
          limit,
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
  (t) => !['send_urgent_alert', 'get_outbound_call_status', 'outbound_phone_call'].includes(t.name),
)

export const PERSONAL_SAFE_TOOLS: AgentTool[] = [
  get_current_datetime,
  save_memory,
  search_memory,
  update_memory,
  delete_memory,
  ...PERSONAL_REMINDER_TOOLS,
  ...FAMILY_TOOLS,
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
]

export const TOOLS: AgentTool[] = [
  ...CORE_AGENT_TOOLS,
  ...ERP_TOOLS,
  ...CONFIRM_TOOLS,
  ...STAFF_TOOLS,
  ...SETTINGS_TOOLS,
  ...SALAH_TOOLS,
  ...FINANCE_TOOLS,
  ...OWNER_CUSTOMER_INTEL_TOOLS,
  ...COST_TOOLS,
  ...REMINDER_TOOLS,
  ...ASK_TOOLS,
  ...ADS_TOOLS,
  ...LOCATION_TOOLS,
  ...CATALOG_TOOLS,
  ...WEBSITE_TOOLS,
  ...RESEARCH_TOOLS,
  ...SEO_TOOLS,
  ...COMPETITOR_TOOLS,
  ...ADVISOR_TOOLS,
  ...OWNER_TODO_TOOLS,
  ...PLAYBOOK_TOOLS,
  ...TRYON_TOOLS,
  ...DIAGNOSTIC_TOOLS,
  ...CONTENT_ENGINE_TOOLS,
  ...AD_CREATIVE_TOOLS,
  ...VIDEO_TOOLS,
  ...BRAND_TOOLS,
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
  const pool = businessId === 'ALMA_TRADING' ? TRADING_TOOLS : TOOLS
  const tool = pool.find((t) => t.name === name)
  if (!tool) {
    // Fall back to full registry to surface a clearer error and avoid hard-fails
    // when a shared tool is somehow renamed; the not-found path is still safe.
    const anyTool = TOOLS.find((t) => t.name === name)
    if (!anyTool) return { success: false, error: `Unknown tool: ${name}` }
    if (businessId === 'ALMA_TRADING') {
      return {
        success: false,
        error: `Tool "${name}" Trading registry-এ available নয় — Lifestyle conversation এ চেষ্টা করুন।`,
      }
    }
    return await anyTool.handler({ ...input, ...serverContext })
  }
  try {
    return await tool.handler({ ...input, ...serverContext })
  } catch (err) {
    return { success: false, error: String(err) }
  }
}
