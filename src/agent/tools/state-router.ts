/**
 * Phase 3 — state-aware capability router (roadmap §C, AGENT-ROUTER-001).
 *
 * The old selectors route on MESSAGE TEXT alone, so "হ্যাঁ / ঠিক আছে / continue"
 * says nothing about the domain and the head either gets the fixed 201-tool set
 * (prod) or a keyword-guessed pack (preview). This router asks a different
 * question first: WHAT JOB IS ALREADY IN FLIGHT?
 *
 * Routing order (structured state precedes text, per the roadmap):
 *   1. Pending approval cards        → the pack that can act on that card
 *   2. Unresolved checkpoints        → the pack that resumes that task
 *   3. Active plan                   → plan tools
 *   4. Deterministic keyword intent  → curated domain packs
 *   5. No confident signal           → return null; caller falls back to the
 *      existing selector (never capability-starve on a guess)
 *
 * HARD LIMIT: a head request never carries more than 24 tools (CI-enforced).
 * Rollout: AGENT_STATE_ROUTER=true force-on, =false kill switch; default ON in
 * Vercel preview only — production keeps the proven fixed set until the owner
 * canaries this (roadmap Phase 7).
 */
import type Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/prisma'
import { universalToolPipelineEnabled } from '@/agent/config'
import type { AgentBusinessId } from '@/lib/agent-api/business-context'
import type { HeadTier } from '@/agent/lib/models/head-router'
import type { ToolGroupName } from './tool-groups'
import { TOOLS } from './registry'
import {
  applyToolCacheControl,
  selectToolsAndGroupsForTurnAsync,
  toolsToDefinitions,
} from './select-tools'

export const HEAD_TOOL_HARD_LIMIT = 24

// ── Phase 7 — canary rollout modes (roadmap release discipline) ──────────────
//   'on'                — router selects tools (preview default since Phase 3)
//   'off'               — kill switch: legacy selector only, no prediction
//   'shadow'            — legacy selector EXECUTES, router only PREDICTS and its
//                         prediction is logged in the route span (rollout step 1;
//                         production default from Phase 7)
//   { canaryPct: N }    — AGENT_STATE_ROUTER=canary:N → a stable N% of
//                         conversations (hash of conversationId) run the router,
//                         the rest shadow. 10 → 25 → 50 → 100 per the runbook.
export type StateRouterMode = 'on' | 'off' | 'shadow' | { canaryPct: number }

export function resolveStateRouterMode(
  flag = process.env.AGENT_STATE_ROUTER,
  vercelEnv = process.env.VERCEL_ENV,
): StateRouterMode {
  if (flag === 'true') return 'on'
  if (flag === 'false') return 'off'
  if (flag === 'shadow') return 'shadow'
  const canary = /^canary:(\d{1,3})$/.exec(flag ?? '')
  if (canary) return { canaryPct: Math.max(0, Math.min(100, Number(canary[1]))) }
  if (vercelEnv === 'preview') return 'on'
  if (vercelEnv === 'production') return 'shadow'
  return 'off'
}

/** Stable FNV-1a bucket — the same conversation always lands in the same cohort. */
export function conversationInCanary(conversationId: string, pct: number): boolean {
  if (pct >= 100) return true
  if (pct <= 0) return false
  let h = 2166136261
  for (let i = 0; i < conversationId.length; i++) {
    h ^= conversationId.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) % 100 < pct
}

/** @deprecated Phase 7 — use resolveStateRouterMode(); kept for external readers. */
export const STATE_ROUTER_ENABLED = (() => {
  const mode = resolveStateRouterMode()
  return mode === 'on'
})()

// ── Curated domain packs ─────────────────────────────────────────────────────
// Names are validated against the capability manifest + owner pool by
// state-router coverage tests, so a rename breaks CI, not a live turn.

/** Always-on core: memory, ask, task tracking, approvals read, delegation. */
export const CORE_PACK = [
  'get_current_datetime',
  'save_memory',
  'search_memory',
  'ask_user',
  'track_open_task',
  'resolve_open_task',
  'save_task_checkpoint',
  'get_pending_approvals',
  'delegate_to_specialist',
  // Universal pipeline Phase 1: the ESCAPE HATCH. A routed turn ships ≤24 tools,
  // so a request the packs didn't anticipate used to leave the head with no way
  // to reach the other ~300 registry tools — it could only say "tool নেই" (the
  // exact 2026-07-22 live incident, one pack narrower). find_tool searches the
  // FULL registry and loads matched schemas for the rest of the turn, so the
  // whole registry stays ONE hop away from every routed turn. ~60 tokens.
  'find_tool',
  // B6 — "আর জিজ্ঞেস কোরো না, তুমি নিজে করো" arrives in the middle of ANY job,
  // so the tool that answers it belongs in the pack every turn carries. Live on
  // 2026-08-01 it was registered, allowed, on the head's diet list and named in
  // the prompt — and still absent, because pack selection decides membership and
  // the diet only filters. Three honest "I can't" replies before the mechanism
  // was found. ~40 tokens.
  'request_standing_permission',
  // The way back (`revoke_standing_permission`) is NOT here: the core pack sits
  // against the 24-tool ceiling, and revoking is rarer than asking. It stays on
  // the head's core list, in ALWAYS_ALLOWED, and one find_tool hop from any
  // routed turn.
] as const

export const DOMAIN_PACKS = {
  salah: [
    'get_salah_status', 'get_prayer_times', 'mark_salah', 'get_salah_weekly_summary',
    'request_salah_delay', 'set_salah_time', 'get_salah_time_config', 'set_salah_override',
  ],
  finance: [
    'log_expense', 'log_expenses_batch', 'log_ledger_entry', 'log_ledger_entries_batch',
    'get_expense_summary', 'get_ledger_balances', 'list_recent_transactions',
    'delete_finance_entry', 'edit_finance_entry', 'get_financial_health', 'cashflow_forecast', 'simulate_outcome',
  ],
  erp: [
    'get_sales_summary', 'get_orders', 'get_inventory_status', 'get_product',
    'get_dashboard_snapshot', 'check_order_issues', 'get_reorder_suggestions',
    'analyze_returns', 'analyze_pricing', 'get_customer_summary', 'order_lifecycle_scan',
    // B1: the pack that reads orders must also be able to propose a change to one.
    'update_order', 'update_orders',
  ],
  staff_read: [
    'get_staff_tasks', 'get_all_staff', 'get_dispatch_status', 'get_current_proposal',
    'get_lunch_status', 'list_staff_leave', 'get_shift_handover', 'get_weekly_report_card', 'get_attendance',
  ],
  staff_dispatch: [
    'prepare_staff_task_proposal', 'propose_staff_tasks', 'merge_into_proposal', 'get_current_proposal',
    'approve_and_dispatch_tasks', 'approve_pending_dispatch', 'add_staff_task_now',
    'update_staff_task_status', 'set_staff_task_due', 'explain_staff_task_bangla',
    'send_staff_announcement', 'get_all_staff',
  ],
  social: [
    'get_fb_recent_posts', 'get_fb_messenger_inbox', 'get_unanswered_comments',
    'post_to_facebook', 'publish_to_instagram', 'send_customer_message', 'reply_to_comment',
    'generate_image', 'list_product_assets',
  ],
  ads: [
    'recommend_ad_actions', 'list_audiences', 'pause_campaign', 'update_campaign_budget',
    'duplicate_campaign', 'launch_campaign', 'create_retargeting_audience', 'create_lookalike_audience',
    'get_marketing_history', 'marketing_report',
  ],
  browser: [
    'live_browser_look', 'live_browser_act', 'live_browser_status', 'live_browser_pair',
    'live_browser_trust', 'run_browser_task', 'check_browser_task', 'list_browser_recipes', 'run_browser_recipe',
  ],
  website: [
    'get_website_catalog', 'get_website_health', 'fetch_website_page', 'publish_product',
    'unpublish_product', 'set_product_featured', 'update_product_web', 'get_design_group', 'get_size_for_age',
    // edit_storefront_product is the batched form of the three staging tools
    // above: one card for the whole edit instead of one per field.
    'edit_storefront_product',
  ],
  // change_product_slug is deliberately NOT here. The seo pack is already at the
  // 24-tool hard limit, and a URL rename is an owner-facing decision the HEAD
  // stages (it is on the head shortlist) — never something a delegated worker
  // should reach for on its own.
  seo: [
    'audit_product_seo', 'draft_seo_fixes', 'run_website_seo_audit', 'check_website_seo_audit',
    // `untrack_keyword` left the pack when the core gained
    // request_standing_permission (2026-08-01): seo was at the 24-tool ceiling
    // and something had to give. Removing a keyword from tracking is the
    // rarest ask here and is one find_tool hop away.
    'track_keyword', 'list_tracked_keywords', 'submit_to_indexnow',
    'get_search_console_performance', 'get_indexing_status', 'get_ga4_report',
    // The client_seo batch contract ENDS on complete_skill_pack_run; without it
    // in the pack the contract could never be satisfied, and the owner's final
    // message was overwritten with a progress placeholder forever (2026-07-25).
    'start_skill_pack', 'complete_skill_pack_run',
    // A deliverable is the required end state of any audit — the head must be
    // able to file the live dashboard as a chat artifact.
    'save_artifact',
  ],
  creative: [
    'generate_image', 'run_creative_studio', 'check_studio_job', 'make_ad_creatives',
    'make_product_reel', 'generate_on_model_image', 'generate_on_model_batch',
    'manage_model_library', 'list_creative_studio_assets', 'list_product_assets',
  ],
  cs: [
    'get_fb_messenger_inbox', 'get_customer_intelligence', 'get_customer_segments',
    'cs_autonomy_status', 'get_unanswered_comments', 'send_customer_message',
  ],
  reminders: [
    'set_reminder', 'list_reminders', 'cancel_reminder', 'snooze_reminder',
    'outbound_phone_call', 'place_agent_call', 'get_outbound_call_status', 'preview_call_voice', 'send_urgent_alert',
  ],
  plan: [
    'make_plan', 'execute_plan', 'get_plan', 'get_workflow_history', 'get_duty_day', 'get_graph_health',
    'start_fix_campaign', 'record_root_cause', 'get_fix_campaign',
  ],
  workbench: ['run_workbench_task', 'check_workbench_task'],
  diag: ['run_health_scan', 'diagnose_issue', 'read_source_file', 'get_audit_summary'],
  cost: ['get_api_balances', 'set_api_credit', 'list_subscriptions', 'add_subscription'],
  vision: ['qc_inspect_photo', 'extract_invoice', 'read_screenshot', 'read_competitor_poster', 'compare_to_brand'],
  todo: ['add_owner_todo', 'list_owner_todos', 'update_owner_todo', 'get_daily_digest', 'manage_work_todos'],
  research: [
    'web_research', 'confirm_oxylabs_spend', 'research_competitor', 'research_seo_keywords',
    'research_competitor_creatives', 'manage_competitor_watchlist',
  ],
  camera: ['get_office_camera_snapshot', 'camera_speak', 'get_staff_location', 'get_staff_location_history'],
  // The owner's own Mac (M1/M2). Registering the tools and naming them in the
  // prompt is not enough on a routed turn — without a pack the router never puts
  // them in the request, and the head correctly reports it has no such tool.
  // Live-hit 2026-07-31: "amar mac e git status dekho" answered "tool available
  // নেই" with the daemon paired and online.
  mac: [
    'run_mac_command', 'check_mac_command', 'mac_agent_status', 'mac_desk_control',
    'start_cli_session', 'send_to_cli_session', 'read_cli_session', 'stop_cli_session',
    'list_cli_sessions',
  ],
} as const

export type PackKey = keyof typeof DOMAIN_PACKS

// ── Phase 6 — the marketing head profile ─────────────────────────────────────
// The Qwen marketing head used to bypass the router entirely and carry SIX whole
// groups (~150 schemas, ~30k tokens/request, no diet, no delegation). It also
// produced the "ads tool nai" incident when it was pinned explicitly and landed
// on the slim generic profile instead. Under the router it gets a real profile:
// the same core MINUS delegation (owner rule: Qwen does marketing ITSELF), with
// the marketing packs PRE-SEEDED so the ads/social/creative tools are present
// whatever the message says.
export const MARKETING_CORE_PACK = CORE_PACK.filter((n) => n !== 'delegate_to_specialist')
export const MARKETING_SEED_PACKS: PackKey[] = ['ads', 'social', 'creative']

/**
 * Pack → the TOOL_GROUPS name whose prompt documentation/snapshot gating fits it.
 * Keeps buildLifestyleStaticPrompt + business-snapshot/pulse injection working
 * unchanged when the state router picks the tools.
 */
const PACK_HOME_GROUP: Record<PackKey, ToolGroupName[]> = {
  salah: ['salah'],
  finance: ['finance'],
  erp: ['erp'],
  staff_read: ['staff'],
  staff_dispatch: ['staff'],
  social: ['erp', 'content'],
  ads: ['growth'],
  browser: ['base'],
  website: ['website'],
  seo: ['growth'],
  creative: ['content'],
  cs: ['cs'],
  reminders: ['base'],
  plan: ['base'],
  workbench: ['base'],
  diag: ['diag'],
  cost: ['cost'],
  vision: ['vision'],
  todo: ['base'],
  research: ['growth'],
  camera: ['base'],
  // Mac tools live in CORE_AGENT_TOOLS, which is spread into `base`.
  mac: ['base'],
}

// ── 1-3. Structured state signals (precede text routing) ─────────────────────

/** Pending-approval card type → the pack that can act on/around it. */
export function packsForPendingActionType(type: string): PackKey[] {
  const t = type.toLowerCase()
  if (/(image|video)_gen|studio/.test(t)) return ['creative']
  if (/fb_post|instagram|customer_message|reply_to_comment|gbp/.test(t)) return ['social']
  if (/dispatch|staff/.test(t)) return ['staff_dispatch']
  if (/campaign|audience|ads/.test(t)) return ['ads']
  if (/browser/.test(t)) return ['browser']
  if (/workbench/.test(t)) return ['workbench']
  if (/call|alert|reminder/.test(t)) return ['reminders']
  if (/seo/.test(t)) return ['seo']
  if (/finance|expense|ledger/.test(t)) return ['finance']
  if (/website|product_publish|product_web/.test(t)) return ['website']
  if (/oxylabs|research/.test(t)) return ['research']
  return []
}

/** Checkpoint taskType → the pack that resumes that task. */
export function packsForCheckpointTaskType(taskType: string): PackKey[] {
  const t = taskType.toLowerCase()
  if (/browser/.test(t)) return ['browser']
  if (/plan|long_agent/.test(t)) return ['plan']
  if (/(image|video)_gen|studio|creative/.test(t)) return ['creative']
  if (/seo/.test(t)) return ['seo']
  if (/workbench/.test(t)) return ['workbench']
  return ['plan']
}

// ── 4. Deterministic keyword intent (Bangla + Banglish) ─────────────────────

const INTENT_RULES: Array<{ pack: PackKey; re: RegExp }> = [
  { pack: 'salah', re: /salah|নামাজ|নামায|prayer|namaz|fajr|dhuhr|asr|maghrib|isha|ফজর|যোহর|আসর|মাগরিব|ইশা|জুম্মা|পড়েছি|পড়লাম|poreci|porlam/i },
  { pack: 'finance', re: /expense|ledger|খরচ|টাকা দিসি|ধার|দেনা|পাওনা|hisab|হিসাব|balance|cashflow|নগদ|profit|margin|লাভ|simulate|projection/i },
  { pack: 'staff_dispatch', re: /task (দাও|পাঠাও|dao|pathao)|dispatch|approve kor|টাস্ক (দাও|পাঠাও|বানাও)|proposal|announce|নোটিশ|staff.*(পাঠাও|বলো|জানাও)|কাজ (দাও|ভাগ)/i },
  { pack: 'staff_read', re: /staff|স্টাফ|হাজিরা|attendance|lunch|leave|ছুটি|handover|report card|কে কী করছে|কাজ (করছে|হয়েছে|হলো)|task.*(status|হয়েছে|holo|hoise)/i },
  { pack: 'erp', re: /order|অর্ডার|stock|স্টক|inventory|product|প্রোডাক্ট|দাম|price|sales|বিক্রি|sell|customer|কাস্টমার|reorder|return|রিটার্ন|dashboard/i },
  { pack: 'social', re: /facebook|fb|post|পোস্ট|instagram|insta|messenger|inbox|ইনবক্স|comment|কমেন্ট|reply|পেজ|page/i },
  // Ad-metric words route to `ads` (recommend_ad_actions has the per-campaign
  // impressions/clicks/CTR) — live-hit 2026-07-17: an ads-performance question
  // fell to `finance` on "খরচ" and answered from a tool that has no CTR.
  { pack: 'ads', re: /\bads?\b|advert|বুস্ট|boost|campaign|ক্যাম্পেইন|roas|budget.*(ad|campaign)|audience|lookalike|retarget|অ্যাড|এড|impression|ইমপ্রেশন|\bctr\b|সিটিআর|clicks?|ক্লিক|reach|রিচ|অ্যাড.*(পারফরম্যান্স|খরচ)|পারফরম্যান্স/i },
  { pack: 'browser', re: /browser|ব্রাউজার|chrome|খুলে দেখ|website.*(খোল|open)|login কর|সাইটে (যাও|ঢোক)|live.*(দেখ|browser)/i },
  { pack: 'website', re: /almatraders|আমাদের (সাইট|website)|publish|আনপাবলিশ|catalog|ক্যাটালগ|featured|ওয়েবসাইটে/i },
  { pack: 'seo', re: /seo|এসইও|keyword|কিওয়ার্ড|rank|র‍্যাংক|google.*(দেখা|position)|indexing|search console|ga4|analytics|অডিট/i },
  { pack: 'creative', re: /ছবি|image|ইমেজ|creative|ক্রিয়েটিভ|poster|পোস্টার|reel|রিল|video বানাও|ভিডিও বানাও|studio|স্টুডিও|try.?on|model (ছবি|photo)|banao.*(chobi|image)/i },
  { pack: 'cs', re: /customer service|winback|segment|সেগমেন্ট|churn|কাস্টমার.*(মেসেজ|জানাও)|cs (mode|auto)/i },
  { pack: 'reminders', re: /remind|রিমাইন্ডার|মনে করিয়ে|call (দাও|কর|দিও|dio|diyo)|কল (দাও|কর|দিও)|ফোন (দাও|কর|দিও)|alert|এলার্ট|জরুরি জানাও/i },
  { pack: 'plan', re: /plan (বানাও|কর|দেখাও)|প্ল্যান|পরিকল্পনা|step by step|ধাপে ধাপে/i },
  { pack: 'diag', re: /সমস্যা|error|bug|diagnose|health scan|watchdog|ভেঙে|কাজ করছে না|fail (কেন|করছে)/i },
  { pack: 'cost', re: /api.?(credit|balance|key)|subscription|সাবস্ক্রিপশন|ক্রেডিট|recharge|রিচার্জ|api bill/i },
  { pack: 'vision', re: /screenshot পড়|invoice|রসিদ|receipt|qc|ছবি (check|দেখে বল|inspect)|poster পড়/i },
  { pack: 'todo', re: /todo|টুডু|আমার কাজ|করতে হবে|daily digest|ডাইজেস্ট|আজকের সারাংশ/i },
  { pack: 'research', re: /research|রিসার্চ|competitor|প্রতিযোগী|market (দেখ|ঘেটে)|দাম যাচাই|খুঁজে (দেখ|বের)/i },
  { pack: 'camera', re: /camera|ক্যামেরা|অফিস (দেখাও|দেখি)|কে আছে অফিসে|location|লোকেশন|কোথায় আছে/i },
  // His Mac: terminal work, and the Claude/Codex sessions that run on it. Kept
  // narrow — "mac"/"ম্যাক" plus the words he actually uses for developer work,
  // so ordinary business chat never drags these tools into the request.
  {
    pack: 'mac',
    re: /\bmac\b|ম্যাক|ল্যাপটপ|laptop|terminal|টার্মিনাল|\bgit\b|\bnpm\b|\bbuild\b|টেস্ট চালা|test চালা|\bcommit\b|\bpush\b|claude.{0,12}(session|সেশন)|codex|(session|সেশন).{0,12}(খোল|khol|open)|স্ক্রিনশট (নাও|দাও)|ঘুমাতে দিও না|keep.?awake/i,
  },
]

/** Pure keyword → packs (exported for golden tests). */
export function matchIntentPacks(text: string): PackKey[] {
  const t = text.trim()
  if (!t) return []
  const hits: PackKey[] = []
  for (const rule of INTENT_RULES) {
    if (rule.re.test(t) && !hits.includes(rule.pack)) hits.push(rule.pack)
  }
  return hits
}

/** Short confirmations / continuations carry NO domain — state must decide. */
const CONTINUE_RE = /^(হ্যাঁ|হ্যা|হুম|ha|hmm|ok(ay)?|ঠিক আছে|thik ache|continue|চালিয়ে যাও|চালাও|koro|করো|আগাও|resume|yes|না|na|cancel|বাতিল)[\s!.?,।]*$/i

export function isContinuationText(text: string): boolean {
  const t = text.trim()
  return t.length > 0 && (t.length < 28 && CONTINUE_RE.test(t))
}

// ── Assembly ─────────────────────────────────────────────────────────────────

export interface StateRoutedSelection {
  tools: Anthropic.Messages.Tool[]
  groups: ToolGroupName[]
  router: 'state'
  /** Which packs got in and why — logged in the route span. */
  packs: string[]
  signals: string[]
  /** Tool names trimmed away by the 24 hard cap (visible, never silent). */
  trimmed: string[]
}

/**
 * Pure pack→tools assembly with the hard cap (exported for CI gates).
 * Priority: CORE first, then Phase 5 workflow step tools (the template's EXACT
 * legal next tools — they must survive any trim), then the matched packs.
 *
 * Universal pipeline Phase 1: the packs are drained ROUND-ROBIN, not
 * concatenated. Straight concatenation spent the whole budget on the
 * first-matched pack and starved the last one — "almatraders এ প্রোডাক্টটা
 * publish করো" matches erp+website, and `publish_product` (the tool the message
 * literally asks for) fell off the end of the 24 cap while erp's 11th read
 * survived. Round-robin gives every matched pack its front tools (each pack
 * lists its highest-value tools first), so the trim never removes the intent's
 * own tool while a lower-value one from another pack stays.
 */
export function assemblePack(
  packs: PackKey[],
  workflowTools: string[] = [],
  /**
   * Core override. Phase 6: the marketing head must NOT carry
   * delegate_to_specialist (owner rule — Qwen does marketing itself), so it
   * passes MARKETING_CORE_PACK here instead of the default core.
   */
  core: readonly string[] = CORE_PACK,
): { names: string[]; trimmed: string[] } {
  return assemblePackWithLimit(packs, { workflowTools, core, limit: HEAD_TOOL_HARD_LIMIT })
}

/**
 * The same assembly with a caller-chosen ceiling. Phase 7 uses it for specialist
 * sub-agents (SUBAGENT_TOOL_CAP), which are allowed a wider pack than a head
 * turn because they run once and hold no conversation.
 */
export function assemblePackWithLimit(
  packs: PackKey[],
  opts: { workflowTools?: string[]; core?: readonly string[]; limit?: number } = {},
): { names: string[]; trimmed: string[] } {
  const limit = opts.limit ?? HEAD_TOOL_HARD_LIMIT
  const ordered: string[] = [...(opts.core ?? CORE_PACK)]
  for (const name of opts.workflowTools ?? []) {
    if (!ordered.includes(name)) ordered.push(name)
  }
  const seen = new Set(ordered)
  const queues = packs.map((p) => [...DOMAIN_PACKS[p]] as string[])
  const maxLen = queues.reduce((m, q) => Math.max(m, q.length), 0)
  for (let i = 0; i < maxLen; i++) {
    for (const q of queues) {
      const name = q[i]
      if (!name || seen.has(name)) continue
      seen.add(name)
      ordered.push(name)
    }
  }
  return { names: ordered.slice(0, limit), trimmed: ordered.slice(limit) }
}

/** DB state signals — each read fails open (a DB blip must never block routing). */
async function readStateSignals(conversationId: string): Promise<{
  packs: PackKey[]
  signals: string[]
  /** Phase 5: exact tool names the ACTIVE workflow step legalizes (template-populated). */
  workflowTools: string[]
}> {
  const packs: PackKey[] = []
  const signals: string[] = []
  const workflowTools: string[] = []
  const add = (ps: PackKey[], label: string) => {
    for (const p of ps) if (!packs.includes(p)) packs.push(p)
    signals.push(label)
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const [pending, checkpoints, plans, workflows] = await Promise.all([
    db.agentPendingAction
      .findMany({
        where: { conversationId, status: 'pending' },
        orderBy: { createdAt: 'desc' },
        take: 3,
        select: { id: true, type: true },
      })
      .catch(() => []),
    import('@/agent/lib/checkpoint')
      .then((m) => m.listUnresolvedCheckpoints(conversationId))
      .catch(() => []),
    db.agentPlan
      .findMany({
        where: { conversationId, status: { in: ['running', 'blocked', 'approved'] } },
        orderBy: { updatedAt: 'desc' },
        take: 1,
        select: { id: true },
      })
      .catch(() => []),
    // Phase 4: the CANONICAL job record routes first — its kind is a pack key
    // by construction (run-owner-turn derives it via packsForPendingActionType).
    // Phase 5: template runs carry nextAllowedTools — the step's EXACT legal
    // tools — which narrow the selection beyond whole packs.
    db.workflowRun
      .findMany({
        where: { conversationId, status: { in: ['active', 'waiting_owner', 'waiting_worker'] } },
        orderBy: { updatedAt: 'desc' },
        take: 3,
        select: { id: true, kind: true, status: true, state: true, nextAllowedTools: true },
      })
      .catch(() => []),
  ])
  const { WORKFLOW_TEMPLATES } = await import('@/agent/lib/workflow-templates')
  for (const wf of workflows as Array<{ id: string; kind: string; status: string; state: string; nextAllowedTools?: unknown }>) {
    const allowed = Array.isArray(wf.nextAllowedTools) ? (wf.nextAllowedTools as string[]) : []
    for (const t of allowed) if (!workflowTools.includes(t)) workflowTools.push(t)
    const tpl = WORKFLOW_TEMPLATES[wf.kind]
    if (tpl && tpl.routerPack in DOMAIN_PACKS) {
      add([tpl.routerPack as PackKey], `workflow:${wf.kind}:${wf.state}:${wf.status}`)
    } else if (wf.kind in DOMAIN_PACKS) {
      add([wf.kind as PackKey], `workflow:${wf.kind}:${wf.status}`)
    } else {
      signals.push(`workflow:${wf.kind}:${wf.status}`)
    }
  }
  for (const a of pending as Array<{ id: string; type: string }>) {
    add(packsForPendingActionType(a.type), `pending:${a.type}`)
  }
  for (const cp of checkpoints as Array<{ id: string; checkpoint: { taskType?: string } }>) {
    add(packsForCheckpointTaskType(String(cp.checkpoint?.taskType ?? '')), `checkpoint:${cp.checkpoint?.taskType ?? 'unknown'}`)
  }
  if ((plans as unknown[]).length > 0) add(['plan'], 'plan:active')

  // What the PREVIOUS turn worked on. Without this, a bare follow-up — "abar try
  // koro", "ok koro" — carries no keywords, matches no pack, and the head loses
  // the very tools it was mid-task with. Live-hit 2026-07-31: "amar mac e git
  // status dekho" routed correctly, then "akhon abar try koro" answered "tool
  // callable নয়". Only used when the reply IS a continuation (the caller decides
  // that); a fresh instruction still routes on its own words.
  if (packs.length === 0) {
    try {
      const last = await db.agentMessage.findFirst({
        where: { conversationId, role: 'assistant' },
        orderBy: { createdAt: 'desc' },
        select: { usage: true },
      })
      const prev = (last?.usage as { packs?: unknown } | null)?.packs
      if (Array.isArray(prev)) {
        const carried = prev.filter((p): p is PackKey => typeof p === 'string' && p in DOMAIN_PACKS)
        if (carried.length > 0) add(carried, `carried:${carried.join('+')}`)
      }
    } catch {
      /* no history is not an error — the caller falls back */
    }
  }

  return { packs, signals, workflowTools }
}

/**
 * The state-aware selection. Returns null when it has no confident basis —
 * the caller then uses the existing selector unchanged (never starve on a guess).
 */
export async function selectStateRoutedTools(opts: {
  conversationId: string
  text: string
  businessId: AgentBusinessId
  personalMode: boolean
  headTier?: HeadTier
}): Promise<StateRoutedSelection | null> {
  // Narrow modes keep their proven paths: personal + Trading have small stable
  // sets already.
  if (opts.personalMode || opts.businessId === 'ALMA_TRADING') return null
  // Phase 6: the Qwen marketing head joins the pipeline, flag-gated. Off → it
  // keeps its legacy 6-group full-marketing profile from select-tools.
  const marketing = opts.headTier === 'marketing'
  if (marketing && !universalToolPipelineEnabled()) return null

  const state = await readStateSignals(opts.conversationId)
  const intentPacks = matchIntentPacks(opts.text)
  const continuation = isContinuationText(opts.text)

  // Structured state precedes text: on a continuation reply, state alone decides.
  // With no state and no keyword hit, we have no confident basis → fall back.
  const basePacks: PackKey[] = continuation && state.packs.length > 0
    ? state.packs
    : [...state.packs, ...intentPacks.filter((p) => !state.packs.includes(p))]
  // Marketing: whatever the message matched comes FIRST (round-robin gives the
  // leading queues their slots first), then the seed packs fill in — so the
  // marketing head can never truthfully say "ads tool nai".
  const packs: PackKey[] = marketing
    ? [...basePacks, ...MARKETING_SEED_PACKS.filter((p) => !basePacks.includes(p))]
    : basePacks
  if (packs.length === 0 && state.workflowTools.length === 0) return null

  const core = marketing ? MARKETING_CORE_PACK : CORE_PACK
  // Phase 5 narrowing: a continuation reply inside a template-driven workflow
  // exposes ONLY the step's legal tools (+ core) — the smallest legal pack the
  // roadmap asks for. Any new-intent text keeps the pack union so the owner can
  // always pivot mid-job.
  const narrowToWorkflow = continuation && state.workflowTools.length > 0
  const { names, trimmed } = narrowToWorkflow
    ? assemblePack([], state.workflowTools, core)
    : assemblePack(packs, state.workflowTools, core)
  const byName = new Map(TOOLS.map((t) => [t.name, t]))
  const selected = names.map((n) => byName.get(n)).filter((t): t is NonNullable<typeof t> => Boolean(t))
  if (selected.length === 0) return null

  const groups: ToolGroupName[] = ['base']
  for (const p of packs) {
    for (const g of PACK_HOME_GROUP[p]) if (!groups.includes(g)) groups.push(g)
  }

  if (trimmed.length > 0) {
    console.warn(`[state-router] pack over ${HEAD_TOOL_HARD_LIMIT} — trimmed: ${trimmed.join(', ')}`)
  }

  return {
    tools: applyToolCacheControl(toolsToDefinitions(selected)),
    groups,
    router: 'state',
    packs,
    signals: [...state.signals, ...(intentPacks.length ? [`intent:${intentPacks.join('+')}`] : [])],
    trimmed,
  }
}

export interface OwnerToolSelection {
  tools: Anthropic.Messages.Tool[]
  groups: ToolGroupName[]
  router: 'state' | 'legacy'
  packs?: string[]
  signals?: string[]
  trimmed?: string[]
  /**
   * Phase 7 shadow mode: what the state router WOULD have done while the legacy
   * selector executed — logged in the route span, so real prod traffic scores
   * the router's recall/precision before any canary percentage is turned on.
   */
  shadow?: {
    wouldRoute: boolean
    packs?: string[]
    signals?: string[]
    toolCount?: number
    trimmed?: number
  }
}

/**
 * The single owner-head selection entry point (run-owner-turn).
 * Phase 7 rollout ladder (AGENT_STATE_ROUTER): off → shadow (predict+log,
 * legacy executes; prod default) → canary:N (stable N% of conversations run
 * the router) → true (100%). Every mode fails open to the legacy selector.
 */
export async function selectOwnerHeadTools(opts: {
  conversationId: string
  text: string
  businessId: AgentBusinessId
  personalMode: boolean
  headTier?: HeadTier
}): Promise<OwnerToolSelection> {
  const mode = resolveStateRouterMode()
  const routedLive =
    mode === 'on'
    || (typeof mode === 'object' && conversationInCanary(opts.conversationId, mode.canaryPct))

  if (routedLive) {
    try {
      const routed = await selectStateRoutedTools(opts)
      if (routed) return routed
    } catch (err) {
      console.warn('[state-router] failed open → legacy selector:', err instanceof Error ? err.message : err)
    }
  }
  const legacy = await selectToolsAndGroupsForTurnAsync(opts.text, {
    personalMode: opts.personalMode,
    businessId: opts.businessId,
    headTier: opts.headTier,
  })

  // Shadow prediction (also for the non-canary cohort of a canary rollout):
  // cheap indexed reads; a prediction failure must never touch the live turn.
  if (mode === 'shadow' || (typeof mode === 'object' && !routedLive)) {
    try {
      const predicted = await selectStateRoutedTools(opts)
      return {
        ...legacy,
        router: 'legacy',
        shadow: predicted
          ? {
              wouldRoute: true,
              packs: predicted.packs,
              signals: predicted.signals,
              toolCount: predicted.tools.length,
              trimmed: predicted.trimmed.length,
            }
          : { wouldRoute: false },
      }
    } catch { /* prediction is telemetry only */ }
  }
  return { ...legacy, router: 'legacy' }
}
