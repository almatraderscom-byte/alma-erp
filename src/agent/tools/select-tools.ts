import type Anthropic from '@anthropic-ai/sdk'
import type { AgentBusinessId } from '@/lib/agent-api/business-context'
import type { HeadTier } from '@/agent/lib/models/head-router'
import { TOOL_GROUPS, type ToolGroupName } from '@/agent/tools/tool-groups'
import type { AgentTool } from '@/agent/tools/registry'
import { semanticGroups } from '@/agent/tools/semantic-router'

const AMBIGUOUS_FALLBACK: ToolGroupName[] = ['erp', 'staff']

const SHORT_GREETING_RE =
  /^(hei|hi|hello|hey|hii|ok|okay|thanks|thank you|dhonnobad|ধন্যবাদ|kemon|ki khobor|কেমন|কি খবর|assalam|salam|আসসালাম|salamu|জি|ha|হ্যা|na|না)[\s!.?,]*$/i

export type ToolGroupResult = {
  groups: ToolGroupName[]
  confident: boolean
}

/**
 * Pure keyword-based tool-group selection (synchronous).
 * Returns groups and a confidence signal.
 */
export function selectToolGroupsSync(
  text: string,
  opts: { personalMode: boolean; businessId: AgentBusinessId },
): ToolGroupResult {
  if (opts.personalMode) return { groups: ['personal'], confident: true }
  if (opts.businessId === 'ALMA_TRADING') return { groups: ['base', 'trading'], confident: true }

  const g = new Set<ToolGroupName>(['base'])
  const t = text.trim()

  if (t.length < 24 && SHORT_GREETING_RE.test(t)) {
    return { groups: ['base', 'erp'], confident: true }
  }

  if (t.length < 12 && g.size === 1) {
    return { groups: ['base', 'erp'], confident: true }
  }

  if (/staff|হাজিরা|টাস্ক|বেতন|fine|eyafi|mustahid|dispatch|approve|পাঠাও/i.test(t)) {
    g.add('staff')
    g.add('finance')
  }
  if (/order|stock|inventory|product|দাম|price|reorder|catalog/i.test(t)) g.add('erp')
  if (/customer|messenger|cs|winback|segment|inbox/i.test(t)) g.add('cs')
  if (/\bads?\b|advert|বুস্ট|campaign|seo|competitor|গ্রো|marketing|intel|optimizer|ROAS|scale|plan_marketing|marketing_report|মার্কেটিং|ফানেল/i.test(t)) g.add('growth')
  if (/content|ছবি|image|post|model|try.?on|ব্র্যান্ড|facebook|fb|creative|অফার|offer|poster|reel|video|ভিডিও|রিল/i.test(t)) g.add('content')
  if (/website|almatraders|publish|catalog/i.test(t)) g.add('website')
  if (/salah|নামাজ|prayer|namaz|fajr|dhuhr|asr|maghrib|isha|ফজর|যোহর|আসর|মাগরিব|ইশা|জুম্মা|poreci|porlam|পড়েছি|পড়লাম|নামায/i.test(t)) g.add('salah')
  if (/expense|ledger|finance|খরচ|টাকা|bdt|aed|simulate|projection|what.?if|restock|break.?even/i.test(t)) g.add('finance')
  if (/api.?(credit|balance|key)|subscription|সাবস্ক্রিপশন|ক্রেডিট|recharge|রিচার্জ|credit.?balance|api.?bill/i.test(t)) g.add('cost')
  if (/সমস্যা|error|bug|diagnose|health|watchdog/i.test(t)) g.add('diag')
  if (/qc|screenshot|invoice|রসিদ|receipt|brand.?check|ছবি.*(?:check|দেখ|inspect)|photo.*(?:check|inspect|qc)|poster.*(?:check|read|দেখ)/i.test(t)) g.add('vision')

  if (g.size === 1) {
    for (const x of AMBIGUOUS_FALLBACK) g.add(x)
  }

  const groups = [...g]

  // Confident when keywords matched something beyond the base+ambiguous fallback,
  // or the message is trivially short/greeting
  const isAmbiguousFallback =
    g.size <= 3 &&
    groups.every(gr => gr === 'base' || AMBIGUOUS_FALLBACK.includes(gr))
  const isNonTrivial = t.length >= 24 && !SHORT_GREETING_RE.test(t)
  const confident = !(isAmbiguousFallback && isNonTrivial)

  return { groups, confident }
}

/** Backward-compatible wrapper — returns groups only. */
export function selectToolGroups(
  text: string,
  opts: { personalMode: boolean; businessId: AgentBusinessId },
): ToolGroupName[] {
  return selectToolGroupsSync(text, opts).groups
}

export function dedupeToolsByName(tools: AgentTool[]): AgentTool[] {
  const seen = new Set<string>()
  const out: AgentTool[] = []
  for (const tool of tools) {
    if (seen.has(tool.name)) continue
    seen.add(tool.name)
    out.push(tool)
  }
  return out
}

export function assembleSelectedTools(groups: ToolGroupName[]): AgentTool[] {
  const merged = groups.flatMap((g) => TOOL_GROUPS[g] ?? [])
  return dedupeToolsByName(merged)
}

export function toolsToDefinitions(tools: AgentTool[]): Anthropic.Messages.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }))
}

/** Cache breakpoint on the last tool — caches the whole tool prefix block. */
export function applyToolCacheControl(tools: Anthropic.Messages.Tool[]): Anthropic.Messages.Tool[] {
  if (tools.length === 0) return tools
  return tools.map((t, i) =>
    i === tools.length - 1
      ? ({ ...t, cache_control: { type: 'ephemeral', ttl: '1h' } } as Anthropic.Messages.Tool)
      : t,
  )
}

/** Synchronous tool selection (keyword-only). Used by tests and fast paths. */
export function selectToolsForTurnSync(
  text: string,
  opts: { personalMode: boolean; businessId: AgentBusinessId },
): Anthropic.Messages.Tool[] {
  const { groups } = selectToolGroupsSync(text, opts)
  const tools = assembleSelectedTools(groups)
  return applyToolCacheControl(toolsToDefinitions(tools))
}

/** Keep old sync name working for existing call sites during migration. */
export function selectToolsForTurn(
  text: string,
  opts: { personalMode: boolean; businessId: AgentBusinessId },
): Anthropic.Messages.Tool[] {
  return selectToolsForTurnSync(text, opts)
}

const WIDE_FALLBACK: ToolGroupName[] = ['base', 'erp', 'staff', 'finance']

/**
 * STABLE owner-chat tool set (ALMA Lifestyle business chat).
 *
 * Why fixed instead of per-keyword: Anthropic prompt caching only reuses a
 * byte-identical PREFIX (tools → system → history). Tools sit at the very front,
 * so if the tool list changes between two messages, the WHOLE cached prefix
 * (tools + role-prompt system block) is invalidated and rewritten at the
 * expensive cache-WRITE rate ($3.75/M) every turn — which is ~90% of a chat
 * message's cost. Keyword-picked tools differed wildly turn-to-turn (e.g. 52 vs
 * 91 tools, not even prefix-compatible), so the cache was essentially never
 * reused.
 *
 * Loading one fixed, comprehensive set makes the prefix identical every turn, so
 * follow-up messages READ the cache ($0.30/M, 12.5× cheaper) instead of
 * rewriting it. Trade-off: the first (cold) message in a 5-min window writes a
 * slightly larger prefix; every message after that is much cheaper. Net win for
 * the owner's real pattern (bursts of messages in one sitting).
 *
 * Excludes only the other-mode groups: 'trading' (separate business) and
 * 'personal' (personal mode). 'salah' tools already live in 'base'.
 */
const OWNER_STABLE_GROUPS: ToolGroupName[] = [
  'base',
  'erp',
  'staff',
  'finance',
  'cs',
  'content',
  'growth',
  'website',
  'diag',
  'vision',
  'cost',
]

// ── Slim Head Router (Project A, Step 2) — opt-in via ENABLE_SLIM_ROUTER ──────
// When ON, the owner-chat HEAD carries a leaner tool set and DELEGATES the heavy
// non-critical domains to specialist sub-agents (cheap workers), instead of
// shipping all 14 groups' schemas in the cached prefix every turn — the main cost
// driver. Default ON (owner runs it live, protected by the delegation approval
// gate); set ENABLE_SLIM_ROUTER=false to disable.
// Critical execution still runs on Claude via the sub-agent tier guard.
export const SLIM_ROUTER_ENABLED = process.env.ENABLE_SLIM_ROUTER !== 'false'

// The head profile. This first (safe) cut drops only `content` + `growth` — the two
// largest groups, both fully covered by delegatable workers (content→content,
// growth→marketer/researcher) so NO capability is lost, it's routed not removed,
// and there's no clash with staff/salah per-turn prompt nudges. `base` keeps
// delegate_to_specialist + memory/ask/salah/reminders. Tune toward fewer groups
// (drop erp/finance/staff/cs) once delegation prompting + the cs worker are wired.
const ROUTER_HEAD_GROUPS: ToolGroupName[] = [
  'base', 'erp', 'staff', 'finance', 'cs', 'website', 'diag', 'vision', 'cost',
]

// Delegation approval test mode (DELEGATION_APPROVAL=true): force marketing work
// to transfer to a specialist by removing the marketing read-tools that leak into
// the kept erp/staff groups, so the head can't quietly do it itself.
const DELEGATION_APPROVAL_TEST = process.env.DELEGATION_APPROVAL !== 'false'
const DELEGATION_FORCE_DENYLIST = new Set<string>([
  'get_marketing_intel',
  'get_marketing_history',
  'get_fb_recent_posts',
])

/**
 * Async tool selection. For owner business chat (ALMA Lifestyle) we return a
 * STABLE comprehensive set so the prompt-cache prefix is identical every turn
 * (see OWNER_STABLE_GROUPS). Personal mode and ALMA Trading keep their own
 * already-stable narrow sets. Keyword/semantic routing is retained only for
 * those narrow modes and for the sync selector (tests / refusal telemetry).
 */
export async function selectToolsAndGroupsForTurnAsync(
  text: string,
  opts: { personalMode: boolean; businessId: AgentBusinessId; headTier?: HeadTier },
): Promise<{ tools: Anthropic.Messages.Tool[]; groups: ToolGroupName[] }> {
  // Owner business chat → fixed prefix for cache reuse. Slim Head Router (when
  // enabled) carries the lean head profile and delegates heavy domains to workers.
  if (!opts.personalMode && opts.businessId !== 'ALMA_TRADING') {
    const groups = SLIM_ROUTER_ENABLED ? ROUTER_HEAD_GROUPS : OWNER_STABLE_GROUPS
    let assembled = assembleSelectedTools(groups)
    // The Qwen marketing head answers marketing DIRECTLY: it KEEPS its marketing
    // read-tools (so it can read the page / history itself). It ALSO keeps
    // delegate_to_specialist — but the worker it hands to is now DeepSeek (the
    // cheap worker), NOT Qwen, so the old "double-Qwen" reason to strip it is
    // void. Keeping delegation is what lets the HARD tool-round budget force the
    // expensive Qwen head to hand the rest of a long job to the cheap worker.
    // Every other head keeps the delegation-test behavior unchanged.
    const isMarketingHead = opts.headTier === 'marketing'
    if (DELEGATION_APPROVAL_TEST && !isMarketingHead) {
      // Delegation test mode: strip the marketing read-tools that leak into kept
      // groups so the head CANNOT do marketing itself → it must transfer to a
      // specialist (which the owner then approves). Reversible; flag-gated.
      assembled = assembled.filter((t) => !DELEGATION_FORCE_DENYLIST.has(t.name))
    }
    return { tools: applyToolCacheControl(toolsToDefinitions(assembled)), groups }
  }

  const { groups, confident } = selectToolGroupsSync(text, opts)

  if (confident) {
    const tools = assembleSelectedTools(groups)
    return { tools: applyToolCacheControl(toolsToDefinitions(tools)), groups }
  }

  // Low confidence — try semantic fallback
  try {
    const semGroups = await semanticGroups(text)
    if (semGroups.length > 0) {
      const merged = [...new Set<ToolGroupName>([...groups, ...semGroups])]
      const tools = assembleSelectedTools(merged)
      return { tools: applyToolCacheControl(toolsToDefinitions(tools)), groups: merged }
    }
  } catch (err) {
    console.warn('[select-tools] semantic fallback failed:', err instanceof Error ? err.message : err)
  }

  // Widen to safe defaults so agent isn't capability-starved
  const widened = [...new Set<ToolGroupName>([...groups, ...WIDE_FALLBACK])]
  const tools = assembleSelectedTools(widened)
  return { tools: applyToolCacheControl(toolsToDefinitions(tools)), groups: widened }
}

/**
 * Tool Search (deferred tool loading) — opt-in via AGENT_TOOL_SEARCH=true.
 *
 * Like Claude Code: instead of shipping all ~160 owner tool schemas every turn
 * (~30-50k tokens), keep the everyday set fully loaded and mark the specialised
 * long tail (content/growth/website/diag/vision/cost) `defer_loading`. The model
 * uses the regex tool-search tool to pull a deferred schema only when it actually
 * needs it; loaded schemas are appended after the cached prefix, so the prompt
 * cache is preserved. Default OFF — production behaviour is unchanged until the
 * owner flips the flag in a preview to test.
 */
export const TOOL_SEARCH_ENABLED = (() => {
  const flag = process.env.AGENT_TOOL_SEARCH
  if (flag === 'true') return true // force ON anywhere
  if (flag === 'false') return false // force OFF anywhere (instant kill switch)
  // Default: ON automatically in Vercel PREVIEW so all three fixes can be tested
  // together with zero extra setup; OFF in production until the owner approves.
  return process.env.VERCEL_ENV === 'preview'
})()

// Everyday groups whose tools stay fully loaded; everything else defers.
const TOOL_SEARCH_CORE_GROUPS: ToolGroupName[] = ['base', 'erp', 'staff', 'finance']

export function applyToolSearchDeferral(
  tools: Anthropic.Messages.Tool[],
): Anthropic.Messages.ToolUnion[] {
  const coreNames = new Set(
    TOOL_SEARCH_CORE_GROUPS.flatMap((g) => (TOOL_GROUPS[g] ?? []).map((t) => t.name)),
  )
  const prepared: Anthropic.Messages.ToolUnion[] = tools.map((t) => {
    // Drop any existing cache breakpoint; a single one is re-added at the very end.
    const { cache_control: _omit, ...rest } = t as Anthropic.Messages.Tool & { cache_control?: unknown }
    const def = { ...rest } as Anthropic.Messages.Tool
    if (!coreNames.has(t.name)) def.defer_loading = true
    return def
  })
  prepared.push({
    type: 'tool_search_tool_regex_20251119',
    name: 'tool_search_tool_regex',
  } as Anthropic.Messages.ToolSearchToolRegex20251119)
  const lastIdx = prepared.length - 1
  prepared[lastIdx] = {
    ...prepared[lastIdx],
    cache_control: { type: 'ephemeral', ttl: '1h' },
  } as Anthropic.Messages.ToolUnion
  return prepared
}

/**
 * Async hybrid tool selection: keyword fast-path when confident,
 * semantic embedding fallback when ambiguous. Returns tools only (back-compat).
 */
export async function selectToolsForTurnAsync(
  text: string,
  opts: { personalMode: boolean; businessId: AgentBusinessId },
): Promise<Anthropic.Messages.Tool[]> {
  return (await selectToolsAndGroupsForTurnAsync(text, opts)).tools
}
