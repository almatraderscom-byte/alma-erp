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

export const STATE_ROUTER_ENABLED = (() => {
  const flag = process.env.AGENT_STATE_ROUTER
  if (flag === 'true') return true // force ON anywhere
  if (flag === 'false') return false // instant kill switch
  return process.env.VERCEL_ENV === 'preview'
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
  ],
  seo: [
    'audit_product_seo', 'draft_seo_fixes', 'run_website_seo_audit', 'check_website_seo_audit',
    'track_keyword', 'list_tracked_keywords', 'untrack_keyword', 'submit_to_indexnow',
    'get_search_console_performance', 'get_indexing_status', 'get_ga4_report',
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
  plan: ['make_plan', 'execute_plan', 'get_plan'],
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
} as const

export type PackKey = keyof typeof DOMAIN_PACKS

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
  { pack: 'ads', re: /\bads?\b|advert|বুস্ট|boost|campaign|ক্যাম্পেইন|roas|budget.*(ad|campaign)|audience|lookalike|retarget/i },
  { pack: 'browser', re: /browser|ব্রাউজার|chrome|খুলে দেখ|website.*(খোল|open)|login কর|সাইটে (যাও|ঢোক)|live.*(দেখ|browser)/i },
  { pack: 'website', re: /almatraders|আমাদের (সাইট|website)|publish|আনপাবলিশ|catalog|ক্যাটালগ|featured|ওয়েবসাইটে/i },
  { pack: 'seo', re: /seo|এসইও|keyword|কিওয়ার্ড|rank|র‍্যাংক|google.*(দেখা|position)|indexing|search console|ga4|analytics|অডিট/i },
  { pack: 'creative', re: /ছবি|image|ইমেজ|creative|ক্রিয়েটিভ|poster|পোস্টার|reel|রিল|video বানাও|ভিডিও বানাও|studio|স্টুডিও|try.?on|model (ছবি|photo)|banao.*(chobi|image)/i },
  { pack: 'cs', re: /customer service|winback|segment|সেগমেন্ট|churn|কাস্টমার.*(মেসেজ|জানাও)|cs (mode|auto)/i },
  { pack: 'reminders', re: /remind|রিমাইন্ডার|মনে করিয়ে|call (দাও|কর)|কল (দাও|কর)|ফোন (দাও|কর)|alert|এলার্ট|জরুরি জানাও/i },
  { pack: 'plan', re: /plan (বানাও|কর|দেখাও)|প্ল্যান|পরিকল্পনা|step by step|ধাপে ধাপে/i },
  { pack: 'diag', re: /সমস্যা|error|bug|diagnose|health scan|watchdog|ভেঙে|কাজ করছে না|fail (কেন|করছে)/i },
  { pack: 'cost', re: /api.?(credit|balance|key)|subscription|সাবস্ক্রিপশন|ক্রেডিট|recharge|রিচার্জ|api bill/i },
  { pack: 'vision', re: /screenshot পড়|invoice|রসিদ|receipt|qc|ছবি (check|দেখে বল|inspect)|poster পড়/i },
  { pack: 'todo', re: /todo|টুডু|আমার কাজ|করতে হবে|daily digest|ডাইজেস্ট|আজকের সারাংশ/i },
  { pack: 'research', re: /research|রিসার্চ|competitor|প্রতিযোগী|market (দেখ|ঘেটে)|দাম যাচাই|খুঁজে (দেখ|বের)/i },
  { pack: 'camera', re: /camera|ক্যামেরা|অফিস (দেখাও|দেখি)|কে আছে অফিসে|location|লোকেশন|কোথায় আছে/i },
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
 * legal next tools — they must survive any trim), then packs in the order
 * given; first HEAD_TOOL_HARD_LIMIT names survive, the rest are reported as
 * trimmed.
 */
export function assemblePack(packs: PackKey[], workflowTools: string[] = []): { names: string[]; trimmed: string[] } {
  const ordered: string[] = [...CORE_PACK]
  for (const name of workflowTools) {
    if (!ordered.includes(name)) ordered.push(name)
  }
  for (const p of packs) {
    for (const name of DOMAIN_PACKS[p]) {
      if (!ordered.includes(name)) ordered.push(name)
    }
  }
  return {
    names: ordered.slice(0, HEAD_TOOL_HARD_LIMIT),
    trimmed: ordered.slice(HEAD_TOOL_HARD_LIMIT),
  }
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
  // sets already; the Qwen marketing head runs its own full-marketing profile.
  if (opts.personalMode || opts.businessId === 'ALMA_TRADING' || opts.headTier === 'marketing') return null

  const state = await readStateSignals(opts.conversationId)
  const intentPacks = matchIntentPacks(opts.text)
  const continuation = isContinuationText(opts.text)

  // Structured state precedes text: on a continuation reply, state alone decides.
  // With no state and no keyword hit, we have no confident basis → fall back.
  const packs: PackKey[] = continuation && state.packs.length > 0
    ? state.packs
    : [...state.packs, ...intentPacks.filter((p) => !state.packs.includes(p))]
  if (packs.length === 0 && state.workflowTools.length === 0) return null

  // Phase 5 narrowing: a continuation reply inside a template-driven workflow
  // exposes ONLY the step's legal tools (+ core) — the smallest legal pack the
  // roadmap asks for. Any new-intent text keeps the pack union so the owner can
  // always pivot mid-job.
  const narrowToWorkflow = continuation && state.workflowTools.length > 0
  const { names, trimmed } = narrowToWorkflow
    ? assemblePack([], state.workflowTools)
    : assemblePack(packs, state.workflowTools)
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
}

/**
 * The single owner-head selection entry point (run-owner-turn): state router
 * when enabled and confident, otherwise the existing selector — byte-identical
 * behavior when the flag is off.
 */
export async function selectOwnerHeadTools(opts: {
  conversationId: string
  text: string
  businessId: AgentBusinessId
  personalMode: boolean
  headTier?: HeadTier
}): Promise<OwnerToolSelection> {
  if (STATE_ROUTER_ENABLED) {
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
  return { ...legacy, router: 'legacy' }
}
