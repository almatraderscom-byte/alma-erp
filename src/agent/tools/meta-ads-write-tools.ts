// Meta Ads MCP — WRITE tools (Phase MA3). Money-touching, so every one is
// staged behind the owner's approval-card system; nothing spends without an
// explicit Approve, and even then Meta creates entities PAUSED. `ads_activate_entity`
// (the switch that starts spend) is a SEPARATE before_execute card with a red
// warning. All of them are triple-gated: owner must (1) re-connect at write tier,
// (2) Approve the card, and (3) the ad account must be inside Meta's MCP rollout —
// so the mere presence of this code cannot move a single taka on its own.
//
// Pattern mirrors ads-tools.ts: the tool handler validates + creates an
// agentPendingAction row (type `meta_ads:<remoteName>`); on Approve the
// actions/[id]/approve route calls metaMcpCallTool(remoteName, args) and
// cost-logs it. Args are Meta's own schema (passthrough) — the head gets the
// exact shape from meta_ads_list_tools.
import { prisma } from '@/lib/prisma'
import type { AgentTool, ToolResult } from './registry'
import { META_MCP_TOOL_CAPABILITIES, bridgedToolName, isRegisterableAtTier } from '@/agent/lib/meta-mcp/bridge'
import {
  getMetaMcpConnection,
  getMetaMcpMaxDailyBudget,
  getMetaMcpScopeTier,
  isMetaMcpEnabled,
  isMetaMcpEnvEnabled,
} from '@/agent/lib/meta-mcp/oauth'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/** The write tools MA3 registers (all mode !== 'read' in the capability map). */
export const META_MCP_WRITE_TOOL_NAMES = Object.keys(META_MCP_TOOL_CAPABILITIES).filter(
  (n) => META_MCP_TOOL_CAPABILITIES[n].mode !== 'read',
)

function unwrapArgs(input: Record<string, unknown>): Record<string, unknown> {
  if (input.args && typeof input.args === 'object' && !Array.isArray(input.args)) {
    return input.args as Record<string, unknown>
  }
  const { args: _drop, conversationId: _c, ...rest } = input
  return rest
}

function disabledResult(): ToolResult {
  const detail = isMetaMcpEnvEnabled() ? 'kv সেটিং meta_mcp_enabled বন্ধ।' : 'সার্ভারে META_MCP_ENABLED সেট নেই।'
  return { success: false, error: `Meta Ads MCP বন্ধ — ${detail}`, errorCode: 'handler_error', retryable: false }
}

/** Shared write-side gate: kill switch + connection + tier ≥ write (defense in depth). */
async function writeGate(originalName: string): Promise<ToolResult | null> {
  if (!(await isMetaMcpEnabled())) return disabledResult()
  if (!(await getMetaMcpConnection())) {
    return {
      success: false,
      error: 'Meta Ads MCP connect করা নেই — /agent/growth পেজে Connect চাপুন।',
      errorCode: 'auth',
      retryable: false,
    }
  }
  const tier = await getMetaMcpScopeTier()
  if (!isRegisterableAtTier(originalName, tier)) {
    return {
      success: false,
      error:
        'এই লেখা-টুলটা বর্তমান read-only সংযোগে চলে না। Boss-কে /agent/growth পেজে read/write tier-এ আবার Connect করতে বলুন।',
      errorCode: 'auth',
      retryable: false,
    }
  }
  return null
}

/**
 * Budget guardrail (plan §6). Meta's budget fields (`daily_budget` /
 * `lifetime_budget`) are ALWAYS in the account currency's MINOR unit (cents) —
 * the documented convention of the Graph Ads API the MCP wraps. So the
 * whole-unit amount is value ÷ 100, and we refuse anything above the owner cap.
 * Always-÷100 is the safe reading: any large minor-unit value stays large after
 * ÷100 and is caught, so a runaway budget can never slip through (a value passed
 * as whole units by mistake only reads SMALLER, never larger). When Meta enables
 * the account this convention should be re-confirmed against a real write.
 */
async function overBudget(args: Record<string, unknown>): Promise<{ over: true; message: string } | null> {
  const cap = await getMetaMcpMaxDailyBudget()
  const raw = args.daily_budget ?? args.lifetime_budget
  if (raw == null) return null
  const minor = Number(raw)
  if (!Number.isFinite(minor) || minor <= 0) return null
  const whole = minor / 100
  if (whole <= cap) return null
  return {
    over: true,
    message:
      `বাজেট (~${whole.toFixed(2)}) আপনার সেট করা সর্বোচ্চ দৈনিক বাজেট (${cap})-এর বেশি — নিরাপত্তার জন্য থামালাম। ` +
      'বাড়াতে চাইলে Boss বলুন "meta_mcp_max_daily_budget বাড়িয়ে দাও", তারপর আবার চেষ্টা করব।',
  }
}

async function stageWrite(
  originalName: string,
  args: Record<string, unknown>,
  summary: string,
  conversationId: string | null,
): Promise<ToolResult> {
  const action = await db.agentPendingAction.create({
    data: {
      conversationId,
      type: `meta_ads:${originalName}`,
      payload: { remoteName: originalName, args },
      summary,
      costEstimate: 0,
      status: 'pending',
    },
  })
  return {
    success: true,
    data: { pendingActionId: action.id as string, summary, message: 'Pending owner approval — Meta-তে PAUSED অবস্থায় তৈরি হবে।' },
  }
}

// ── Individual staged write tools ────────────────────────────────────────────

const meta_ads_create_campaign: AgentTool = {
  name: bridgedToolName('ads_create_campaign'),
  description:
    '[Meta Ads — official MCP, WRITE] Drafts a NEW Meta ad campaign via the official MCP. ALWAYS creates an owner ' +
    'approval card; on Approve the campaign is created PAUSED (never spends until separately activated). Pass Meta\'s ' +
    'arguments inside "args" (schema via meta_ads_list_tools). Budget over the owner cap is refused.',
  input_schema: {
    type: 'object' as const,
    properties: {
      args: { type: 'object', description: "Meta's ads_create_campaign arguments (name, objective, etc.), forwarded verbatim.", additionalProperties: true },
      conversationId: { type: 'string', description: 'Server-managed — omit.' },
    },
    required: [],
  },
  handler: async (input) => {
    const gated = await writeGate('ads_create_campaign')
    if (gated) return gated
    const args = unwrapArgs(input)
    const budget = await overBudget(args)
    if (budget) return { success: false, error: budget.message, errorCode: 'handler_error', retryable: false }
    const objective = String(args.objective ?? args.name ?? 'নতুন ক্যাম্পেইন')
    const summary = `নতুন Meta ক্যাম্পেইন তৈরি?\nObjective: ${objective}\n⚠️ তৈরি হবে PAUSED অবস্থায় — Approve করলেও নিজে থেকে খরচ শুরু হবে না।`
    return stageWrite('ads_create_campaign', args, summary, input.conversationId ? String(input.conversationId) : null)
  },
}

const meta_ads_create_ad_set: AgentTool = {
  name: bridgedToolName('ads_create_ad_set'),
  description:
    '[Meta Ads — official MCP, WRITE] Drafts a NEW ad set (audience + daily budget) under a campaign. ALWAYS an ' +
    'approval card; created PAUSED. Budget over the owner cap is refused. Args = Meta\'s ads_create_ad_set schema.',
  input_schema: {
    type: 'object' as const,
    properties: {
      args: { type: 'object', description: "Meta's ads_create_ad_set arguments (campaign_id, daily_budget, targeting…), verbatim.", additionalProperties: true },
      conversationId: { type: 'string', description: 'Server-managed — omit.' },
    },
    required: [],
  },
  handler: async (input) => {
    const gated = await writeGate('ads_create_ad_set')
    if (gated) return gated
    const args = unwrapArgs(input)
    const budget = await overBudget(args)
    if (budget) return { success: false, error: budget.message, errorCode: 'handler_error', retryable: false }
    const dailyRaw = args.daily_budget
    const summary =
      `নতুন Meta অ্যাড সেট তৈরি?\n${dailyRaw != null ? `দৈনিক বাজেট: ${dailyRaw} (অ্যাকাউন্ট মুদ্রায়)\n` : ''}⚠️ তৈরি হবে PAUSED অবস্থায়।`
    return stageWrite('ads_create_ad_set', args, summary, input.conversationId ? String(input.conversationId) : null)
  },
}

const meta_ads_create_ad: AgentTool = {
  name: bridgedToolName('ads_create_ad'),
  description:
    '[Meta Ads — official MCP, WRITE] Drafts a NEW ad (creative) under an ad set. ALWAYS an approval card; created ' +
    'PAUSED. Args = Meta\'s ads_create_ad schema (adset_id, creative…).',
  input_schema: {
    type: 'object' as const,
    properties: {
      args: { type: 'object', description: "Meta's ads_create_ad arguments, verbatim.", additionalProperties: true },
      conversationId: { type: 'string', description: 'Server-managed — omit.' },
    },
    required: [],
  },
  handler: async (input) => {
    const gated = await writeGate('ads_create_ad')
    if (gated) return gated
    const args = unwrapArgs(input)
    const summary = 'নতুন Meta অ্যাড (creative) তৈরি?\n⚠️ তৈরি হবে PAUSED অবস্থায়।'
    return stageWrite('ads_create_ad', args, summary, input.conversationId ? String(input.conversationId) : null)
  },
}

const meta_ads_update_entity: AgentTool = {
  name: bridgedToolName('ads_update_entity'),
  description:
    '[Meta Ads — official MCP, WRITE] Edits an existing campaign / ad set / ad (e.g. budget, name, targeting). ALWAYS ' +
    'an approval card. Budget over the owner cap is refused. Warns (does not block) if the same entity was edited in ' +
    'the last 24h (Meta learning phase). Args = Meta\'s ads_update_entity schema (entity id + fields).',
  input_schema: {
    type: 'object' as const,
    properties: {
      args: { type: 'object', description: "Meta's ads_update_entity arguments (id + fields to change), verbatim.", additionalProperties: true },
      conversationId: { type: 'string', description: 'Server-managed — omit.' },
    },
    required: [],
  },
  handler: async (input) => {
    const gated = await writeGate('ads_update_entity')
    if (gated) return gated
    const args = unwrapArgs(input)
    const budget = await overBudget(args)
    if (budget) return { success: false, error: budget.message, errorCode: 'handler_error', retryable: false }

    // Learning-phase guard (warn, don't block): repeatedly editing the same
    // entity resets Meta's optimisation. Surface it in the card, let the owner decide.
    const entityId = String(args.id ?? args.entity_id ?? '')
    let learningWarn = ''
    if (entityId) {
      try {
        const recent = await db.agentPendingAction.findFirst({
          where: {
            type: 'meta_ads:ads_update_entity',
            status: 'executed',
            resolvedAt: { gte: new Date(Date.now() - 24 * 3600_000) },
            payload: { path: ['args', 'id'], equals: entityId },
          },
        })
        if (recent) learningWarn = '\n⚠️ গত ২৪ ঘণ্টায় এই এন্টিটি একবার বদলানো হয়েছে — বারবার বদলালে Meta-র learning রিসেট হয়।'
      } catch {
        /* guard is best-effort */
      }
    }
    const summary = `Meta এন্টিটি এডিট?\nID: ${entityId || '(args-এ)'}${learningWarn}`
    return stageWrite('ads_update_entity', args, summary, input.conversationId ? String(input.conversationId) : null)
  },
}

const meta_ads_catalog_create: AgentTool = {
  name: bridgedToolName('ads_catalog_create'),
  description:
    '[Meta Ads — official MCP, WRITE] Creates a NEW product catalog. ALWAYS an approval card. Args = Meta\'s ' +
    'ads_catalog_create schema.',
  input_schema: {
    type: 'object' as const,
    properties: {
      args: { type: 'object', description: "Meta's ads_catalog_create arguments, verbatim.", additionalProperties: true },
      conversationId: { type: 'string', description: 'Server-managed — omit.' },
    },
    required: [],
  },
  handler: async (input) => {
    const gated = await writeGate('ads_catalog_create')
    if (gated) return gated
    const args = unwrapArgs(input)
    const summary = `নতুন Meta প্রোডাক্ট ক্যাটালগ তৈরি?\nName: ${String(args.name ?? '(args-এ)')}`
    return stageWrite('ads_catalog_create', args, summary, input.conversationId ? String(input.conversationId) : null)
  },
}

/**
 * The money switch. Meta creates entities PAUSED; THIS starts spend. Its own
 * before_execute card with a red warning; HEAVY_DENY routing already forces the
 * heavy head on these turns. Same triple gate applies.
 */
const meta_ads_activate_entity: AgentTool = {
  name: bridgedToolName('ads_activate_entity'),
  description:
    '[Meta Ads — official MCP, WRITE · 🔴 STARTS SPEND] Turns a PAUSED campaign / ad set / ad ACTIVE — this is the ' +
    'switch that begins real ad spend. ALWAYS a separate approval card with a money warning; never bundled with ' +
    'create. Args = Meta\'s ads_activate_entity schema (entity id).',
  input_schema: {
    type: 'object' as const,
    properties: {
      args: { type: 'object', description: "Meta's ads_activate_entity arguments (entity id), verbatim.", additionalProperties: true },
      conversationId: { type: 'string', description: 'Server-managed — omit.' },
    },
    required: [],
  },
  handler: async (input) => {
    const gated = await writeGate('ads_activate_entity')
    if (gated) return gated
    const args = unwrapArgs(input)
    const entityId = String(args.id ?? args.entity_id ?? '(args-এ)')
    const summary =
      `🔴 Meta অ্যাড চালু (ACTIVE) করব?\nID: ${entityId}\n⚠️ এটা খরচ শুরু করার সুইচ — Approve করলেই আসল টাকা খরচ শুরু হবে।`
    const action = await db.agentPendingAction.create({
      data: {
        conversationId: input.conversationId ? String(input.conversationId) : null,
        type: 'meta_ads:ads_activate_entity',
        payload: { remoteName: 'ads_activate_entity', args },
        summary,
        costEstimate: 0,
        status: 'pending',
      },
    })
    return {
      success: true,
      data: { pendingActionId: action.id as string, summary, message: '🔴 Pending owner approval — this STARTS spend.' },
    }
  },
}

/**
 * MA3 write tool set. Registered in the registry + growth group, but every
 * handler refuses at read tier (writeGate), so they are inert until the owner
 * re-connects at write/financial tier — defense in depth beyond the OAuth scope.
 */
export const META_ADS_WRITE_TOOLS: AgentTool[] = [
  meta_ads_create_campaign,
  meta_ads_create_ad_set,
  meta_ads_create_ad,
  meta_ads_update_entity,
  meta_ads_catalog_create,
  meta_ads_activate_entity,
]
