/**
 * Meta Ads MCP — bridge (Phase MA1).
 *
 * Locked design (plan §2.1): "Bridge, not bypass" — every Meta MCP tool is
 * wrapped as a normal AgentTool so ALL existing discipline applies (contract
 * validation, capability classification, approval cards, claim-verifier, cost
 * logging). No separate execution path.
 *
 * MA1 registers ONLY the read tools. The capability map below covers all 29
 * remote tools (plan §1 inventory) so MA3 can register the write side behind
 * approval cards without re-auditing; bridge.test.ts keeps it exhaustive.
 *
 * Naming: bridged name = `meta_` + original (all originals start with `ads_`,
 * so e.g. ads_insights_performance_trend → meta_ads_insights_performance_trend).
 *
 * Schemas: Meta owns the real input schemas and may evolve them (beta). Each
 * wrapper therefore takes ONE free-form `args` object that is forwarded verbatim
 * (the Phase 2 strict contract hardens only the ROOT schema; nested objects stay
 * permissive by design) and points the head at meta_ads_list_tools, which
 * returns the live schemas from the kv-cached tools/list. Meta validates
 * server-side; its errors flow back for self-repair.
 */
import { prisma } from '@/lib/prisma'
import type { AgentTool, ToolResult } from '@/agent/tools/registry'
import type { CapabilityApproval, CapabilityMode, CapabilityRisk } from '@/agent/tools/tool-contract'
import { metaMcpCallTool, metaMcpListTools, MetaMcpError, type McpToolDescriptor } from './client'
import {
  getMetaMcpConnection,
  getMetaMcpScopeTier,
  isMetaMcpEnabled,
  isMetaMcpEnvEnabled,
  type MetaMcpScopeTier,
} from './oauth'

export const META_TOOL_PREFIX = 'meta_'

export type MetaMcpToolCapability = {
  mode: CapabilityMode
  risk: CapabilityRisk
  approval: CapabilityApproval
  /** Lowest scope tier at which the bridge may register this tool. */
  minTier: MetaMcpScopeTier
}

const read: MetaMcpToolCapability = { mode: 'read', risk: 'low', approval: 'none', minTier: 'read' }
const stagedWrite: MetaMcpToolCapability = { mode: 'stage', risk: 'high', approval: 'staged_card', minTier: 'write' }

/**
 * Exhaustive capability mapping for ALL 29 tools Meta's server exposes
 * (plan §1 + §2.2). Names are the server's own (no prefix).
 */
export const META_MCP_TOOL_CAPABILITIES: Record<string, MetaMcpToolCapability> = {
  // ── Accounts (3) — read ─────────────────────────────────────────────────
  ads_get_ad_accounts: read,
  ads_get_ad_entities: read,
  ads_get_pages_for_business: read,
  // ── Catalog reads (9) ───────────────────────────────────────────────────
  ads_catalog_get_catalogs: read,
  ads_catalog_get_details: read,
  ads_catalog_get_diagnostics: read,
  ads_catalog_get_feed_rules: read,
  ads_catalog_get_product_details: read,
  ads_catalog_get_product_feed_details: read,
  ads_catalog_get_product_set_products: read,
  ads_catalog_get_product_sets: read,
  ads_catalog_get_products: read,
  // ── Dataset / diagnostics (4) — read ────────────────────────────────────
  ads_get_dataset_details: read,
  ads_get_dataset_quality: read,
  ads_get_dataset_stats: read,
  ads_get_errors: read,
  // ── Insights / benchmarks (7) — read ────────────────────────────────────
  ads_insights_advertiser_context: read,
  ads_insights_anomaly_signal: read,
  ads_insights_auction_ranking_benchmarks: read,
  ads_insights_industry_benchmark: read,
  ads_insights_performance_trend: read,
  ads_get_opportunity_score: read,
  ads_get_help_article: read,
  // ── Writes (6) — MA3 registers these behind approval cards ──────────────
  ads_catalog_create: stagedWrite,
  ads_create_campaign: stagedWrite,
  ads_create_ad_set: stagedWrite,
  ads_create_ad: stagedWrite,
  ads_update_entity: stagedWrite,
  // The money switch: Meta creates entities PAUSED; this turns spend ON.
  ads_activate_entity: { mode: 'stage', risk: 'high', approval: 'before_execute', minTier: 'write' },
}

export const META_MCP_READ_TOOL_NAMES = Object.keys(META_MCP_TOOL_CAPABILITIES).filter(
  (n) => META_MCP_TOOL_CAPABILITIES[n].mode === 'read',
)
export const META_MCP_WRITE_TOOL_NAMES = Object.keys(META_MCP_TOOL_CAPABILITIES).filter(
  (n) => META_MCP_TOOL_CAPABILITIES[n].mode !== 'read',
)

export function bridgedToolName(originalName: string): string {
  return `${META_TOOL_PREFIX}${originalName}`
}

/**
 * Defense in depth (plan §2.4): may this remote tool be registered at the
 * current scope tier? Read tools always; write tools only at write/financial —
 * and MA1 has no write wrappers regardless.
 */
export function isRegisterableAtTier(originalName: string, tier: MetaMcpScopeTier): boolean {
  const cap = META_MCP_TOOL_CAPABILITIES[originalName]
  if (!cap) return false
  if (cap.minTier === 'read') return true
  return tier === 'write' || tier === 'financial'
}

// ── Authored descriptions (Bangla-annotated, plan §4) ────────────────────────

const TOOL_HINTS: Record<string, string> = {
  ads_get_ad_accounts: 'Lists the ad accounts the connected Meta Business user can access. বিজ্ঞাপন অ্যাকাউন্টের তালিকা।',
  ads_get_ad_entities: 'Reads campaigns / ad sets / ads (structure + status) in an ad account. ক্যাম্পেইন/অ্যাডসেট/অ্যাডের কাঠামো ও অবস্থা।',
  ads_get_pages_for_business: 'Lists Facebook Pages under the business. বিজনেসের ফেসবুক পেজের তালিকা।',
  ads_catalog_get_catalogs: 'Lists product catalogs of the business. প্রোডাক্ট ক্যাটালগের তালিকা।',
  ads_catalog_get_details: 'Details of one product catalog. একটি ক্যাটালগের বিস্তারিত।',
  ads_catalog_get_diagnostics: 'Catalog health/diagnostics issues. ক্যাটালগের সমস্যা/ডায়াগনস্টিকস।',
  ads_catalog_get_feed_rules: 'Feed rules of a product feed. প্রোডাক্ট ফিডের রুল।',
  ads_catalog_get_product_details: 'Details of one catalog product. একটি প্রোডাক্টের বিস্তারিত।',
  ads_catalog_get_product_feed_details: 'Details of a product feed. প্রোডাক্ট ফিডের বিস্তারিত।',
  ads_catalog_get_product_set_products: 'Products inside a product set. প্রোডাক্ট সেটের ভেতরের প্রোডাক্ট।',
  ads_catalog_get_product_sets: 'Lists product sets in a catalog. ক্যাটালগের প্রোডাক্ট সেটের তালিকা।',
  ads_catalog_get_products: 'Lists/searches products in a catalog. ক্যাটালগের প্রোডাক্ট তালিকা/সার্চ।',
  ads_get_dataset_details: 'Details of a dataset (pixel/CAPI). ডেটাসেট (পিক্সেল/CAPI) বিস্তারিত।',
  ads_get_dataset_quality: 'Event/match quality of a dataset. ডেটাসেটের ইভেন্ট কোয়ালিটি।',
  ads_get_dataset_stats: 'Event stats of a dataset. ডেটাসেটের ইভেন্ট পরিসংখ্যান।',
  ads_get_errors: 'Recent delivery/diagnostic errors. সাম্প্রতিক ডেলিভারি/ডায়াগনস্টিক এরর।',
  ads_insights_advertiser_context: 'Advertiser context summary (vertical, spend context). বিজ্ঞাপনদাতার প্রেক্ষাপট-সারসংক্ষেপ।',
  ads_insights_anomaly_signal: 'Detects performance anomalies (sudden CTR/spend shifts). পারফরম্যান্স-অস্বাভাবিকতা শনাক্ত।',
  ads_insights_auction_ranking_benchmarks: 'Auction ranking benchmarks vs peers. অকশন র‍্যাংকিং বেঞ্চমার্ক।',
  ads_insights_industry_benchmark: 'Industry benchmark comparison (CTR/CPM vs industry). ইন্ডাস্ট্রি গড়ের সাথে তুলনা।',
  ads_insights_performance_trend: 'Performance trend over time (spend, CTR, results). সময়ের সাথে পারফরম্যান্স ট্রেন্ড — “গত ৭ দিনের অ্যাড পারফরম্যান্স” এই টুল দিয়ে।',
  ads_get_opportunity_score: 'Meta opportunity score + recommendations for the ad account. অপরচুনিটি স্কোর ও পরামর্শ।',
  ads_get_help_article: 'Fetches a Meta help article (ads product docs). Meta-র হেল্প আর্টিকেল।',
}

// Passthrough schema: strict root (repo Phase 2 contract) with ONE free-form
// nested `args` object that is forwarded to Meta verbatim.
const PASSTHROUGH_SCHEMA = {
  type: 'object' as const,
  properties: {
    args: {
      type: 'object',
      description:
        "Arguments for Meta's tool, passed through verbatim — exact schema via meta_ads_list_tools. Omit for tools that need none.",
      additionalProperties: true,
    },
  },
  required: [] as string[],
}

/** Unwrap the `args` envelope; tolerate flat input from non-validated callers. */
function forwardedArgs(input: Record<string, unknown>): Record<string, unknown> {
  if (input.args && typeof input.args === 'object' && !Array.isArray(input.args)) {
    return input.args as Record<string, unknown>
  }
  const { args: _ignored, ...rest } = input
  return rest
}

// ── tools/list catalog cache (kv, TTL — plan §8 endpoint-drift mitigation) ──

export const KV_TOOLS_CACHE = 'meta_mcp_tools_cache'
const TOOLS_CACHE_TTL_MS = 6 * 60 * 60 * 1000

type ToolsCache = { fetchedAt: string; tools: McpToolDescriptor[] }

/**
 * The live remote tool catalog, cached in kv. Never throws: on fetch failure
 * returns the stale cache (or null) — a dead catalog must degrade reads
 * gracefully, never crash the registry or a turn.
 */
export async function getRemoteToolCatalog(opts?: { forceRefresh?: boolean }): Promise<ToolsCache | null> {
  let cached: ToolsCache | null = null
  try {
    const row = await prisma.agentKvSetting.findUnique({ where: { key: KV_TOOLS_CACHE }, select: { value: true } })
    if (row?.value) cached = JSON.parse(row.value) as ToolsCache
  } catch {
    cached = null
  }
  const fresh = cached && Date.now() - Date.parse(cached.fetchedAt) < TOOLS_CACHE_TTL_MS
  if (fresh && !opts?.forceRefresh) return cached

  try {
    const tools = await metaMcpListTools()
    if (tools.length > 0) {
      const next: ToolsCache = { fetchedAt: new Date().toISOString(), tools }
      await prisma.agentKvSetting
        .upsert({
          where: { key: KV_TOOLS_CACHE },
          create: { key: KV_TOOLS_CACHE, value: JSON.stringify(next) },
          update: { value: JSON.stringify(next) },
        })
        .catch(() => {})
      return next
    }
  } catch (e) {
    console.warn('[meta-mcp] tools/list refresh failed, using stale cache:', e instanceof Error ? e.message : e)
  }
  return cached
}

// ── Handler plumbing ─────────────────────────────────────────────────────────

function disabledResult(): ToolResult {
  const detail = isMetaMcpEnvEnabled()
    ? 'kv সেটিং meta_mcp_enabled বন্ধ করা আছে।'
    : 'সার্ভারে META_MCP_ENABLED সেট করা নেই।'
  return {
    success: false,
    error: `Meta Ads MCP বন্ধ আছে — ${detail} পুরনো Graph API টুলগুলো আগের মতোই কাজ করে।`,
    errorCode: 'handler_error',
    retryable: false,
  }
}

function notConnectedResult(): ToolResult {
  return {
    success: false,
    error:
      'Meta Ads এখনো connect করা হয়নি। Boss-কে বলুন: /agent/growth পেজে গিয়ে "Connect Meta Ads" চাপতে হবে।',
    errorCode: 'auth',
    retryable: false,
  }
}

function mapMcpError(e: unknown): ToolResult {
  if (e instanceof MetaMcpError) {
    const codeMap: Record<string, string> = {
      not_connected: 'auth',
      auth: 'auth',
      rate_limited: 'rate_limited',
      timeout: 'timeout',
      network: 'network',
      provider_5xx: 'provider_5xx',
      rpc: 'handler_error',
      bad_response: 'handler_error',
    }
    return { success: false, error: e.message, errorCode: codeMap[e.code] ?? 'handler_error', retryable: e.retryable }
  }
  return { success: false, error: e instanceof Error ? e.message : 'meta_mcp_failed', errorCode: 'handler_error', retryable: false }
}

/** Shared pre-flight for every bridged handler: kill switches, connection, tier. */
async function bridgeGate(originalName: string): Promise<ToolResult | null> {
  if (!(await isMetaMcpEnabled())) return disabledResult()
  if (!(await getMetaMcpConnection())) return notConnectedResult()
  const tier = await getMetaMcpScopeTier()
  if (!isRegisterableAtTier(originalName, tier)) {
    return {
      success: false,
      error: `এই টুল (${originalName}) বর্তমান read-only সংযোগে চলে না — Boss উচ্চতর tier-এ আবার Connect করলে খুলবে।`,
      errorCode: 'auth',
      retryable: false,
    }
  }
  return null
}

/** Flatten an MCP tool result into the agent ToolResult envelope. */
function toToolResult(result: { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean }): ToolResult {
  const text = (result.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n')
  let data: unknown = result.structuredContent
  if (data === undefined) {
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = text
    }
  }
  if (result.isError) {
    return {
      success: false,
      error: text || 'Meta MCP tool returned an error',
      errorCode: 'handler_error',
      retryable: false,
    }
  }
  return { success: true, data }
}

function makeBridgedReadTool(originalName: string): AgentTool {
  const hint = TOOL_HINTS[originalName] ?? 'Meta Ads read tool.'
  return {
    name: bridgedToolName(originalName),
    description:
      `[Meta Ads — official MCP, read-only] ${hint} ` +
      'Pass Meta\'s arguments inside the single "args" object (they are forwarded verbatim) — ' +
      'call meta_ads_list_tools first if unsure of the schema; ' +
      'invalid arguments come back as a Meta error you can correct and retry.',
    input_schema: { ...PASSTHROUGH_SCHEMA },
    handler: async (input) => {
      const gated = await bridgeGate(originalName)
      if (gated) return gated
      try {
        // Tolerate remote renames/removals (plan §8): if a FRESH catalog exists
        // and the tool is gone, degrade with a clear message instead of a raw
        // RPC error. A missing/stale catalog never blocks the call.
        const catalog = await getRemoteToolCatalog()
        if (catalog && !catalog.tools.some((t) => t.name === originalName)) {
          console.warn(`[meta-mcp] remote tool missing from catalog: ${originalName}`)
          return {
            success: false,
            error: `Meta এই টুলটা (${originalName}) আর দিচ্ছে না বা নাম বদলেছে — meta_ads_list_tools দিয়ে বর্তমান তালিকা দেখুন।`,
            errorCode: 'not_found',
            retryable: false,
          }
        }
        const result = await metaMcpCallTool(originalName, forwardedArgs(input))
        return toToolResult(result)
      } catch (e) {
        return mapMcpError(e)
      }
    },
  }
}

/** Bridge-local discovery helper: the live tool inventory with real input schemas. */
const meta_ads_list_tools: AgentTool = {
  name: 'meta_ads_list_tools',
  description:
    '[Meta Ads — official MCP] Lists every tool Meta\'s Ads MCP server currently exposes, ' +
    'with descriptions and EXACT input schemas. Meta Ads MCP সার্ভারের লাইভ টুল-তালিকা ও স্কিমা — ' +
    'কোনো meta_ads_* টুলের আর্গুমেন্ট নিয়ে সন্দেহ হলে আগে এটা কল করুন।',
  input_schema: {
    type: 'object' as const,
    properties: {
      refresh: { type: 'boolean', description: 'Force a fresh fetch instead of the cached catalog (default false)' },
    },
    required: [],
  },
  handler: async (input) => {
    if (!(await isMetaMcpEnabled())) return disabledResult()
    if (!(await getMetaMcpConnection())) return notConnectedResult()
    try {
      const catalog = await getRemoteToolCatalog({ forceRefresh: input.refresh === true })
      if (!catalog) {
        return { success: false, error: 'Meta MCP tools/list আনা যায়নি — একটু পরে আবার চেষ্টা করুন।', errorCode: 'network', retryable: true }
      }
      const registered = new Set(META_MCP_READ_TOOL_NAMES)
      return {
        success: true,
        data: {
          fetchedAt: catalog.fetchedAt,
          count: catalog.tools.length,
          tools: catalog.tools.map((t) => ({
            remoteName: t.name,
            agentTool: registered.has(t.name) ? bridgedToolName(t.name) : null,
            available: registered.has(t.name),
            description: t.description ?? '',
            inputSchema: t.inputSchema ?? {},
          })),
          note: 'available=false টুলগুলো write-জাতীয় — MA3-এ approval-card সহ যুক্ত হবে।',
        },
      }
    } catch (e) {
      return mapMcpError(e)
    }
  },
}

/**
 * The MA1 bridged tool set: all 23 read tools + the discovery helper.
 * Write tools are NEVER built here (MA3 registers them behind approval cards);
 * bridge.test.ts asserts this stays true.
 */
export function createMetaAdsReadTools(): AgentTool[] {
  return [meta_ads_list_tools, ...META_MCP_READ_TOOL_NAMES.map(makeBridgedReadTool)]
}
