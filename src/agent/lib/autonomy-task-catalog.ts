/**
 * Phase 51 — Autonomy taxonomy, readiness map, and baseline inventory.
 *
 * Roadmap 3 splits "99% autonomy" into two measurable numbers (coverage and
 * reliability) over an EXPLICITLY DEFINED universe of task classes. This module
 * IS that universe, derived from code wherever possible:
 *
 *   • RISK LADDER  — R0..R4 tiers with default autonomy stance (roadmap table).
 *   • TASK FAMILIES — every personal/business task family the agent is asked to
 *     handle, classified by tier, reversibility, authority, services, duration,
 *     blockers, and success evidence.
 *   • TOOL READINESS MAP — one owner-readable readiness row per EXECUTABLE tool,
 *     generated from the capability manifest. `unknown` is NOT ready.
 *   • FLAG REGISTRY — every off-by-default enable flag with prerequisites and
 *     rollback (exit gate: no flag lists a date instead of prerequisites).
 *   • METRICS — the measurement definitions used by run-autonomy-replay.ts and
 *     later phases; baseline values are reported honestly (unmeasured stays
 *     'unmeasured', thresholds are never moved to hide failures).
 *
 * Read-only inventory: this file performs no actions and holds no secrets.
 */
import { CAPABILITIES, type Capability } from '@/agent/tools/capability-manifest'

// ── Risk ladder (roadmap 3 table, enforced later by the Phase 52 guard) ──────

export type RiskTier = 'R0' | 'R1' | 'R2' | 'R3' | 'R4'

export interface RiskTierSpec {
  tier: RiskTier
  label: string
  examples: string
  defaultAutonomy: string
}

export const RISK_LADDER: readonly RiskTierSpec[] = [
  {
    tier: 'R0',
    label: 'Read-only',
    examples: 'ERP/query, public research, draft analysis',
    defaultAutonomy: 'auto within scoped access',
  },
  {
    tier: 'R1',
    label: 'Reversible private',
    examples: 'save draft, internal todo, generate preview, create paused object',
    defaultAutonomy: 'auto after proven reliability and limits',
  },
  {
    tier: 'R2',
    label: 'Bounded external reversible',
    examples: 'schedule approved content, templated internal reminder, incident pause',
    defaultAutonomy: 'explicit narrow policy + notification + undo',
  },
  {
    tier: 'R3',
    label: 'Consequential',
    examples: 'public publish, customer/staff send, ad budget, account/permission, deletion',
    defaultAutonomy: 'point-of-risk approval by default',
  },
  {
    tier: 'R4',
    label: 'Critical',
    examples: 'money movement, payroll, contracts, security/account recovery',
    defaultAutonomy: 'owner executes or confirms every exact action',
  },
] as const

// ── Task families ─────────────────────────────────────────────────────────────

export type TaskScope = 'personal' | 'business'
export type TaskAuthority = 'auto' | 'owner_policy' | 'point_of_risk' | 'owner_only'

export interface TaskFamily {
  id: string
  label: string
  scope: TaskScope
  tier: RiskTier
  reversible: boolean
  /** Who may authorize this family at the target end-state. */
  authority: TaskAuthority
  /** Services/accounts involved (informational; scoping enforced in Phase 52+). */
  services: string[]
  /** Typical wall-clock duration class: interactive (<30s) vs long (VPS queue). */
  duration: 'interactive' | 'long'
  knownBlockers: string[]
  /** What independently proves success (Phase 53 postcondition classes). */
  successEvidence: string
  /** Representative registry tools (validated against the manifest by tests). */
  representativeTools: string[]
}

export const TASK_FAMILIES: readonly TaskFamily[] = [
  {
    id: 'erp-reporting',
    label: 'ERP reads, reports, briefings, analysis',
    scope: 'business',
    tier: 'R0',
    reversible: true,
    authority: 'auto',
    services: ['erp-db'],
    duration: 'interactive',
    knownBlockers: ['db outage'],
    successEvidence: 'result envelope from the ERP read (no external effect to prove)',
    representativeTools: ['get_sales_summary', 'get_orders', 'get_dashboard_snapshot', 'generate_owner_briefing'],
  },
  {
    id: 'research-public',
    label: 'Public web/competitor/SEO research',
    scope: 'business',
    tier: 'R0',
    reversible: true,
    authority: 'auto',
    services: ['oxylabs', 'google'],
    duration: 'long',
    knownBlockers: ['provider credits', 'rate limits', 'untrusted page content'],
    successEvidence: 'research artifact saved with source origins recorded',
    representativeTools: ['web_research', 'research_competitor', 'research_seo_keywords'],
  },
  {
    id: 'personal-records',
    label: 'Personal records: bills, dates, appointments, meds, documents',
    scope: 'personal',
    tier: 'R1',
    reversible: true,
    authority: 'auto',
    services: ['erp-db'],
    duration: 'interactive',
    knownBlockers: [],
    successEvidence: 'row re-read after write (record proof)',
    representativeTools: ['add_bill', 'add_important_date', 'add_appointment', 'add_medication', 'save_document'],
  },
  {
    id: 'memory-notes',
    label: 'Agent memory, todos, checkpoints, open tasks',
    scope: 'personal',
    tier: 'R1',
    reversible: true,
    authority: 'auto',
    services: ['erp-db', 'pgvector'],
    duration: 'interactive',
    knownBlockers: [],
    successEvidence: 'record re-read; memory recall returns the saved item',
    representativeTools: ['save_memory', 'add_owner_todo', 'track_open_task', 'save_task_checkpoint'],
  },
  {
    id: 'drafts-previews',
    label: 'Drafts and previews: images, creatives, SEO fixes, campaign drafts',
    scope: 'business',
    tier: 'R1',
    reversible: true,
    authority: 'auto',
    services: ['gemini-image', 'fal'],
    duration: 'long',
    knownBlockers: ['provider outage', 'content policy'],
    successEvidence: 'draft/pending-action record exists and is owner-visible',
    representativeTools: ['generate_image', 'draft_seo_fixes', 'make_ad_creatives', 'draft_marketing_campaign'],
  },
  {
    id: 'scheduled-content',
    label: 'Schedule pre-approved content into the calendar',
    scope: 'business',
    tier: 'R2',
    reversible: true,
    authority: 'owner_policy',
    services: ['meta-graph'],
    duration: 'interactive',
    knownBlockers: ['approval expiry', 'calendar conflicts'],
    successEvidence: 'calendar row exists; cancellation path tested (undo)',
    representativeTools: ['schedule_content', 'schedule_content_batch', 'cancel_scheduled_content'],
  },
  {
    id: 'internal-reminders',
    label: 'Internal reminders/alerts to the owner himself',
    scope: 'personal',
    tier: 'R2',
    reversible: true,
    authority: 'owner_policy',
    services: ['telegram', 'ntfy'],
    duration: 'interactive',
    knownBlockers: ['quiet hours'],
    successEvidence: 'reminder row + delivery receipt from the push channel',
    representativeTools: ['set_reminder', 'snooze_reminder', 'cancel_reminder'],
  },
  {
    id: 'staff-messaging',
    label: 'Staff task dispatch, corrections, announcements',
    scope: 'business',
    tier: 'R3',
    reversible: false,
    authority: 'point_of_risk',
    services: ['telegram-staff'],
    duration: 'interactive',
    knownBlockers: ['staff availability', 'Bangla output gate'],
    successEvidence: 'dispatch record + Telegram message id receipt',
    representativeTools: ['approve_and_dispatch_tasks', 'send_staff_announcement', 'approve_pending_dispatch'],
  },
  {
    id: 'customer-messaging',
    label: 'Customer replies: Messenger, WhatsApp, comments',
    scope: 'business',
    tier: 'R3',
    reversible: false,
    authority: 'point_of_risk',
    services: ['meta-graph', 'twilio-wa'],
    duration: 'interactive',
    knownBlockers: ['24h messaging window', 'Bangla output gate', 'template approval'],
    successEvidence: 'provider message id + thread re-read',
    representativeTools: ['send_customer_message', 'send_whatsapp', 'reply_to_comment'],
  },
  {
    id: 'public-publish',
    label: 'Public publishing: FB/IG posts, GBP, website product changes',
    scope: 'business',
    tier: 'R3',
    reversible: false,
    authority: 'point_of_risk',
    services: ['meta-graph', 'gbp', 'website'],
    duration: 'interactive',
    knownBlockers: ['brand/Islamic guardrails', 'image QC'],
    successEvidence: 'public post id + fetch-back of the published object',
    representativeTools: ['post_to_facebook', 'publish_to_instagram', 'publish_product', 'draft_gbp_post'],
  },
  {
    id: 'ads-budget',
    label: 'Meta ads: launch, budget, pause, duplicate',
    scope: 'business',
    tier: 'R3',
    reversible: false,
    authority: 'point_of_risk',
    services: ['meta-ads'],
    duration: 'interactive',
    knownBlockers: ['ad account state', 'billing'],
    successEvidence: 'campaign state re-read from Ads API after change',
    representativeTools: ['launch_campaign', 'update_campaign_budget', 'pause_campaign'],
  },
  {
    id: 'autonomous-browser',
    label: 'Autonomous browser actions on external sites',
    scope: 'business',
    tier: 'R3',
    reversible: false,
    authority: 'point_of_risk',
    services: ['vps-browser', 'live-browser'],
    duration: 'long',
    knownBlockers: ['login walls', 'CAPTCHA (owner-only)', 'hostile pages'],
    successEvidence: 'screenshot + post-action page state + recipe record',
    representativeTools: ['run_browser_task', 'live_browser_act', 'run_browser_recipe'],
  },
  {
    id: 'phone-calls',
    label: 'Outbound phone/WhatsApp calls (staff, family, escalation)',
    scope: 'personal',
    tier: 'R3',
    reversible: false,
    authority: 'point_of_risk',
    services: ['twilio'],
    duration: 'interactive',
    knownBlockers: ['call windows', 'TTS quality'],
    successEvidence: 'Twilio call sid + call status re-read',
    representativeTools: ['outbound_phone_call', 'place_agent_call', 'call_family_member', 'whatsapp_call'],
  },
  {
    id: 'finance-entries',
    label: 'Finance ledger/expense entries (records, not money movement)',
    scope: 'personal',
    tier: 'R3',
    reversible: true,
    authority: 'point_of_risk',
    services: ['erp-db'],
    duration: 'interactive',
    knownBlockers: ['whole-taka rule', 'payroll sensitivity'],
    successEvidence: 'ledger row re-read; balances recomputed',
    representativeTools: ['log_expense', 'log_ledger_entry', 'edit_finance_entry', 'delete_finance_entry'],
  },
  {
    id: 'money-movement',
    label: 'Actual money movement, payroll, purchases, contracts',
    scope: 'business',
    tier: 'R4',
    reversible: false,
    authority: 'owner_only',
    services: ['bank', 'bkash'],
    duration: 'interactive',
    knownBlockers: ['NO TOOL EXISTS on purpose — owner executes'],
    successEvidence: 'owner confirmation + bank/provider receipt',
    representativeTools: [],
  },
  {
    id: 'security-permissions',
    label: 'Master switches, autonomy policy, account/permission changes',
    scope: 'business',
    tier: 'R4',
    reversible: true,
    authority: 'owner_only',
    services: ['erp-db'],
    duration: 'interactive',
    knownBlockers: [],
    successEvidence: 'policy re-read + audit entry',
    representativeTools: ['set_autonomy_policy', 'update_setting', 'heartbeat_control'],
  },
] as const

// ── Tool readiness map (generated from the capability manifest) ───────────────

export type Readiness = 'ready' | 'partial' | 'not_ready'

export interface ToolReadinessRow {
  tool: string
  domain: string
  mode: Capability['mode']
  risk: Capability['risk']
  tier: RiskTier
  approval: Capability['approval']
  idempotencyDeclared: Capability['idempotency']
  /** Baseline audit finding: classification.idempotency has NO runtime use yet. */
  idempotencyEnforced: boolean
  proofDeclared: Capability['proof']
  /** Baseline: proof is enforced only on claim-verifier paths, not per-tool. */
  proofEnforced: boolean
  /** Baseline: only cs/orders/cashflow surfaces consult the autonomy policy. */
  policyWired: boolean
  undoAvailable: boolean
  readiness: Readiness
  note: string
}

/**
 * Derive the risk-ladder tier for a tool from its resolved classification.
 * Staged tools are tiered by the effect the CARD will cause once approved
 * (the card itself is R1, but readiness must reflect the real-world effect).
 */
export function deriveTier(cap: Pick<Capability, 'mode' | 'risk' | 'domain'>): RiskTier {
  if (cap.mode === 'read') return 'R0'
  // Owner-only master switches and policy changes are critical regardless of mode.
  if (cap.domain === 'autonomy' && cap.mode === 'write' && cap.risk === 'high') return 'R4'
  if (cap.mode === 'stage') {
    if (cap.risk === 'high') return 'R3'
    if (cap.risk === 'medium') return 'R2'
    return 'R1'
  }
  // mode === 'write'
  if (cap.risk === 'high') return 'R3'
  if (cap.risk === 'medium') return 'R2'
  return 'R1'
}

/** Domains whose autonomy policy category is actually consulted at baseline. */
const POLICY_WIRED_DOMAINS = new Set(['cs', 'finance', 'erp'])

/** Tools with a working undo path recorded in the autonomy ledger at baseline. */
const UNDOABLE_TOOLS = new Set([
  'add_owner_todo',
  'set_reminder',
  'track_open_task',
  'schedule_content',
  'schedule_content_batch',
  'pause_content_engine',
  'track_keyword',
])

export function buildToolReadinessMap(): ToolReadinessRow[] {
  return CAPABILITIES.map((cap) => {
    const tier = deriveTier(cap)
    const idempotencyEnforced = false // Phase 53 makes this true; honest baseline
    const proofEnforced = false // Phase 52/53 postcondition contract; honest baseline
    const policyWired = POLICY_WIRED_DOMAINS.has(cap.domain)
    const undoAvailable = UNDOABLE_TOOLS.has(cap.name)

    let readiness: Readiness
    let note: string
    if (tier === 'R0') {
      readiness = 'ready'
      note = 'pure read within scoped access'
    } else if (cap.mode === 'stage') {
      readiness = 'partial'
      note = 'effect gated behind an owner approval card; idempotency/proof not yet machine-enforced'
    } else if (tier === 'R1') {
      readiness = 'partial'
      note = 'reversible private write; needs Phase 52 guard + Phase 53 effect ledger before auto'
    } else {
      readiness = 'not_ready'
      note = 'direct external/consequential write; requires guard kernel, effect engine, and staged rollout'
    }

    return {
      tool: cap.name,
      domain: cap.domain,
      mode: cap.mode,
      risk: cap.risk,
      tier,
      approval: cap.approval,
      idempotencyDeclared: cap.idempotency,
      idempotencyEnforced,
      proofDeclared: cap.proof,
      proofEnforced,
      policyWired,
      undoAvailable,
      readiness,
      note,
    }
  })
}

// ── Enable-flag registry (exit gate: prerequisites + rollback, never a date) ──

export interface FlagSpec {
  flag: string
  kind: 'env' | 'kv'
  defaultState: 'off' | 'on'
  purpose: string
  prerequisites: string[]
  rollback: string
}

export const FLAG_REGISTRY: readonly FlagSpec[] = [
  {
    flag: 'AGENT_ENABLED',
    kind: 'env',
    defaultState: 'off',
    purpose: 'Master kill switch — every /api/assistant route checks it first.',
    prerequisites: ['already live in production by owner decision'],
    rollback: 'set AGENT_ENABLED=false in Vercel env — takes effect on next request',
  },
  {
    flag: 'autonomy_enabled',
    kind: 'kv',
    defaultState: 'off',
    purpose: 'Master autonomy policy gate; until on, every decision is ask.',
    prerequisites: [
      'Phase 52 guard kernel covers 100% executable tools',
      'Phase 53 effect ledger blocks unlogged writes',
      'Phase 57 readiness gate passed for at least one R1 class',
    ],
    rollback: 'set agent_kv_settings autonomy_enabled=false — next decision reads it live',
  },
  {
    flag: 'AGENT_AUTODRIVE_ENABLED',
    kind: 'env',
    defaultState: 'off',
    purpose: 'Autodrive plan execution loop (auto-repair, plan caps).',
    prerequisites: [
      'Phase 54 durable graph worker executes plans with checkpoints',
      'Phase 53 exactly-once effect engine live',
      'plan-level daily caps verified in preview',
    ],
    rollback: 'unset env — loop refuses to start on next tick',
  },
  {
    flag: 'browser_agent_enabled',
    kind: 'kv',
    defaultState: 'off',
    purpose: 'Autonomous VPS browser work outside the supervised owner Chrome.',
    prerequisites: [
      'Phase 55 isolated browser profile + egress policy live',
      'Phase 55 red-team corpus passes (zero exfiltration)',
      'domain allowlist configured by owner',
    ],
    rollback: 'set KV browser_agent_enabled=false — worker checks before each task',
  },
  {
    flag: 'cs_followups_enabled',
    kind: 'kv',
    defaultState: 'off',
    purpose: 'CS proactive follow-up messages to customers.',
    prerequisites: [
      'customer-messaging family promoted through Phase 57 ladder to R2 bounded',
      'Bangla output gate pass-rate target met',
      'daily count cap configured',
    ],
    rollback: 'set KV cs_followups_enabled=false — next cron tick stops sends',
  },
  {
    flag: 'content-engine (pause/resume tools)',
    kind: 'kv',
    defaultState: 'off',
    purpose: 'Automated content generation/posting engine.',
    prerequisites: [
      'scheduled-content family promoted through Phase 57 ladder',
      'QC gate (image/brand) pass-rate target met',
      'per-week post cap configured',
    ],
    rollback: 'pause_content_engine tool or KV flag — engine checks per run',
  },
  {
    flag: 'heartbeat (heartbeat_control)',
    kind: 'kv',
    defaultState: 'off',
    purpose: 'Periodic self-initiated business scans and owner-silence checks.',
    prerequisites: [
      'Phase 52 guard kernel live (heartbeat actions pass the same guard)',
      'quiet-hours + interruption budget configured',
    ],
    rollback: 'heartbeat_control off — next scheduled beat exits early',
  },
  {
    flag: 'entrance_watch_enabled / entrance_webhook_enabled',
    kind: 'kv',
    defaultState: 'off',
    purpose: 'Office camera entrance watching and webhook processing.',
    prerequisites: ['camera privacy review', 'staff notice given', 'retention window set'],
    rollback: 'set KV flags false — cron checks each minute',
  },
  {
    flag: 'AGENT_LANGGRAPH_* (turn/workflow/checkpoint/store/interrupt/routine)',
    kind: 'env',
    defaultState: 'off',
    purpose: 'Roadmap 1 LangGraph execution spine feature gates.',
    prerequisites: [
      'Roadmap 1 phase-by-phase gates (owned by Roadmap 1, not this roadmap)',
      'replay suite green on the graph path',
    ],
    rollback: 'unset the specific env flag — legacy path resumes on next turn',
  },
] as const

// ── Metric definitions + honest baseline ─────────────────────────────────────

export type MetricValue = number | 'unmeasured'

export interface MetricSpec {
  id: string
  definition: string
  /** How the number is produced (source of truth). */
  source: string
  /** Baseline value at Phase 51 (honest: unmeasured stays unmeasured). */
  baseline: MetricValue
}

export const AUTONOMY_METRICS: readonly MetricSpec[] = [
  {
    id: 'guard_decision_accuracy',
    definition: 'Share of autonomy replay cases whose allow/stage/deny decision matches the authored expectation.',
    source: 'run-autonomy-replay.ts over src/agent/replay/fixtures/autonomy-*.json',
    baseline: 'unmeasured', // filled by the replay run in the audit doc; code keeps no magic number
  },
  {
    id: 'action_eligibility_coverage',
    definition: 'Share of task families (weighted equally) whose target authority level is currently implemented and wired.',
    source: 'TASK_FAMILIES × buildToolReadinessMap()',
    baseline: 'unmeasured',
  },
  {
    id: 'correct_tool_rate',
    definition: 'Share of replayed owner turns where the head selected the expected tool set (rc-* replay suite).',
    source: 'src/agent/replay fixtures (currently 1 rc case — statistically insufficient, expand)',
    baseline: 'unmeasured',
  },
  {
    id: 'effect_correctness',
    definition: 'Share of attempted external effects that produced exactly the intended change (no duplicate/wrong target).',
    source: 'Phase 53 effect ledger (does not exist at baseline)',
    baseline: 'unmeasured',
  },
  {
    id: 'postcondition_proof_rate',
    definition: 'Share of effects with an independent postcondition read or authoritative receipt stored.',
    source: 'Phase 53 ledger proof column (claim-verifier covers a subset today)',
    baseline: 'unmeasured',
  },
  {
    id: 'recovery_rate',
    definition: 'Share of interrupted long tasks that resumed from checkpoint without restarting from zero.',
    source: 'Phase 54 durable graph runner telemetry',
    baseline: 'unmeasured',
  },
  {
    id: 'rollback_success',
    definition: 'Share of attempted compensations that verifiably restored the prior state.',
    source: 'Phase 53 compensation records (autonomy-ledger undo covers a small subset today)',
    baseline: 'unmeasured',
  },
  {
    id: 'owner_interruption_rate',
    definition: 'Owner asks/approvals per completed eligible task (lower is better once safety holds).',
    source: 'turn telemetry + approval card counts',
    baseline: 'unmeasured',
  },
  {
    id: 'duplicate_external_effect',
    definition: 'Count of externally duplicated effects (target: 0 forever).',
    source: 'Phase 53 ledger reconciliation',
    baseline: 'unmeasured',
  },
  {
    id: 'unapproved_high_impact_effect',
    definition: 'Count of R3/R4 effects executed without point-of-risk approval (target: 0 forever).',
    source: 'Phase 52 guard log × Phase 53 ledger join',
    baseline: 'unmeasured',
  },
] as const

// ── Summary helpers (used by the audit doc generator + tests) ─────────────────

export interface ReadinessSummary {
  totalTools: number
  byTier: Record<RiskTier, number>
  byReadiness: Record<Readiness, number>
  writeToolsWithoutRow: string[]
}

export function summarizeReadiness(rows: ToolReadinessRow[] = buildToolReadinessMap()): ReadinessSummary {
  const byTier: Record<RiskTier, number> = { R0: 0, R1: 0, R2: 0, R3: 0, R4: 0 }
  const byReadiness: Record<Readiness, number> = { ready: 0, partial: 0, not_ready: 0 }
  const covered = new Set(rows.map((r) => r.tool))
  for (const r of rows) {
    byTier[r.tier] += 1
    byReadiness[r.readiness] += 1
  }
  const writeToolsWithoutRow = CAPABILITIES.filter((c) => c.mode !== 'read' && !covered.has(c.name)).map((c) => c.name)
  return { totalTools: rows.length, byTier, byReadiness, writeToolsWithoutRow }
}
