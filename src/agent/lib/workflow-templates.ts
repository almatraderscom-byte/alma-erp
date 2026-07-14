/**
 * Phase 5 (roadmap §F, AGENT-WF-001) — high-value workflow templates.
 *
 * Repeated business jobs are CODE-DEFINED state machines, not prompt paragraphs:
 * every step declares its legal next steps, the tools that are legal while it is
 * active (→ WorkflowRun.nextAllowedTools, which the state router uses to narrow
 * the head's pack), the approval-card types that gate it, the ONE mutating tool
 * it expects (→ per-phase tool_choice binding, roadmap §D), and what counts as
 * completion proof. "HARD RULE: do not post yet" becomes an enforceable
 * invariant instead of prose the model can ignore.
 *
 * The engine (workflow-run.ts) consumes these templates in three places:
 *   - ensureWorkflowRunForPendingAction: card type → template step (attach to
 *     the conversation's active run of the same template, never a duplicate).
 *   - syncWorkflowWithPendingAction: card executed/rejected → template-defined
 *     next step (an executed image card is NOT "done" for a product post — the
 *     run advances to preview_confirm).
 *   - buildWorkflowSnapshotNote / state-router: current step → Bangla label +
 *     legal next tools.
 *
 * Templates are pure data + tiny resolver functions — no I/O here.
 */
import type { WorkflowStatus } from './workflow-run-types'

export interface WorkflowCardStep {
  /** Step the run sits in while this card awaits the owner. */
  stage: string
  /** Step after the card EXECUTES (effect done). Terminal steps set toStatus done. */
  onExecuted: string
  onExecutedStatus: WorkflowStatus
  /** Step after the owner REJECTS the card (default: cancel the run). */
  onRejected?: string
  onRejectedStatus?: WorkflowStatus
  /** Step while the card is approved and queued on the VPS worker. */
  onApproved?: string
}

export interface WorkflowStepDef {
  /** Owner-readable Bangla label for the snapshot note. */
  labelBn: string
  /** Legal next steps (integrity-checked in CI). */
  next: string[]
  /**
   * Tools legal while this step is active — becomes WorkflowRun.nextAllowedTools.
   * The router always adds its CORE pack on top, so ask/memory/task tools need
   * not be repeated here unless the step depends on them.
   */
  allowedTools: string[]
  /** Facts keys that must be truthy in run.facts before tool_choice binding fires. */
  requiresFacts?: string[]
  /**
   * The ONE mutating tool this step exists to produce (roadmap §D "mutating
   * step = named tool, parallel off"). Bound as tool_choice on the first model
   * round of a continuation turn. Resolved against run.facts (e.g. platform).
   */
  expectedTool?: string | ((facts: Record<string, unknown>) => string | null)
  /** WorkflowStatus while the run sits in this step (default 'active'). */
  status?: WorkflowStatus
  /**
   * How an ask_user card answer bound to this run moves the step (e.g. the
   * image preview-confirm gate). null = the answer doesn't move the machine.
   */
  onAskAnswer?: (option: string) => { toState: string; facts?: Record<string, unknown> } | null
}

export interface WorkflowTemplate {
  kind: string
  titleBn: string
  /** Step for a run created outside a card hook (executor hooks, resume). */
  entry: string
  steps: Record<string, WorkflowStepDef>
  /** Pending-action card type → how it moves this template. */
  cardSteps: Record<string, WorkflowCardStep>
  /** State-router pack that fits this job family (fallback when nextAllowedTools is empty). */
  routerPack: string
}

// ── 1. Product Facebook/Instagram post ──────────────────────────────────────
// The 2026-07-13 incident family (5-card spree, imagined product look, post
// before preview confirm, delegated pipeline) — every rule is now a step
// boundary: publishing tools are physically absent until preview_confirmed.
const PRODUCT_POST: WorkflowTemplate = {
  kind: 'product_post',
  titleBn: 'প্রোডাক্ট পোস্ট (FB/IG)',
  entry: 'draft_ready',
  routerPack: 'social',
  steps: {
    draft_ready: {
      labelBn: 'ড্রাফট তৈরি হচ্ছে (আসল ছবি + ক্যাপশন)',
      next: ['creative_approval', 'post_approval'],
      allowedTools: [
        'get_product', 'list_product_assets', 'get_website_catalog',
        'qc_inspect_photo', 'generate_image', 'post_to_facebook', 'publish_to_instagram',
      ],
    },
    creative_approval: {
      labelBn: 'ছবির কার্ড Boss-এর অনুমোদনের অপেক্ষায়',
      next: ['rendering', 'draft_ready'],
      allowedTools: ['get_product', 'list_product_assets', 'get_pending_approvals'],
      status: 'waiting_owner',
    },
    rendering: {
      labelBn: 'ছবি তৈরি হচ্ছে (worker)',
      next: ['preview_confirm'],
      allowedTools: ['get_pending_approvals'],
      status: 'waiting_worker',
    },
    preview_confirm: {
      labelBn: 'ছবি রেডি — Boss-এর preview confirm লাগবে (ask_user card)',
      next: ['post_draft', 'draft_ready'],
      allowedTools: ['ask_user', 'qc_inspect_photo'],
      expectedTool: 'ask_user',
      // The owner's tap on the preview ask-card IS the gate: an affirmative
      // unlocks the post step (facts.previewConfirmed), a change-request drops
      // back to drafting. Enforced by the post_without_preview guard.
      onAskAnswer: (option) => {
        if (/change|বদল|আবার|নতুন|reject|অন্য|(^|\s)না([\s,।!?]|$)/i.test(option)) {
          return { toState: 'draft_ready', facts: { previewConfirmed: false } }
        }
        if (/ঠিক|হ্যাঁ|হ্যা|ok|yes|ভালো|সুন্দর|perfect|post|পোস্ট|দাও|চল/i.test(option)) {
          return { toState: 'post_draft', facts: { previewConfirmed: true } }
        }
        return null
      },
    },
    post_draft: {
      labelBn: 'ছবি confirmed — পোস্ট কার্ড stage করার পালা',
      next: ['post_approval'],
      allowedTools: ['post_to_facebook', 'publish_to_instagram', 'qc_inspect_photo'],
      requiresFacts: ['previewConfirmed'],
      expectedTool: (facts) =>
        facts.platform === 'instagram' ? 'publish_to_instagram' : 'post_to_facebook',
    },
    post_approval: {
      labelBn: 'পোস্ট কার্ড Boss-এর অনুমোদনের অপেক্ষায়',
      next: ['published_verified', 'post_draft'],
      allowedTools: ['get_pending_approvals'],
      status: 'waiting_owner',
    },
    published_verified: {
      labelBn: 'পাবলিশ হয়েছে ও verify হয়েছে',
      next: [],
      allowedTools: ['get_fb_recent_posts'],
      status: 'done',
    },
  },
  cardSteps: {
    image_gen: {
      stage: 'creative_approval',
      onApproved: 'rendering',
      onExecuted: 'preview_confirm',
      onExecutedStatus: 'active',
      // Rejected image = Boss wants a change, NOT job cancelled ("ছবি change চাই"
      // flow) — back to the draft step so the next image card joins THIS run.
      onRejected: 'draft_ready',
      onRejectedStatus: 'active',
    },
    fb_post: {
      stage: 'post_approval',
      onExecuted: 'published_verified',
      onExecutedStatus: 'done',
      onRejected: 'post_draft',
      onRejectedStatus: 'active',
    },
    instagram_post: {
      stage: 'post_approval',
      onExecuted: 'published_verified',
      onExecutedStatus: 'done',
      onRejected: 'post_draft',
      onRejectedStatus: 'active',
    },
    schedule_content: {
      stage: 'post_approval',
      onExecuted: 'published_verified',
      onExecutedStatus: 'done',
    },
  },
}

// ── 2. Full ad campaign setup ────────────────────────────────────────────────
const AD_CAMPAIGN: WorkflowTemplate = {
  kind: 'ad_campaign',
  titleBn: 'অ্যাড ক্যাম্পেইন সেটআপ',
  entry: 'brief_ready',
  routerPack: 'ads',
  steps: {
    brief_ready: {
      labelBn: 'ব্রিফ/প্ল্যান তৈরি হচ্ছে',
      next: ['campaign_approval'],
      allowedTools: [
        'recommend_ad_actions', 'get_marketing_history', 'marketing_report',
        'list_audiences', 'get_product', 'launch_campaign', 'duplicate_campaign',
        'update_campaign_budget', 'pause_campaign',
      ],
      expectedTool: 'launch_campaign',
    },
    campaign_approval: {
      labelBn: 'ক্যাম্পেইন কার্ড Boss-এর অনুমোদনের অপেক্ষায় (approve = সব PAUSED তৈরি হবে)',
      next: ['campaign_created', 'brief_ready'],
      allowedTools: ['get_pending_approvals', 'recommend_ad_actions'],
      status: 'waiting_owner',
    },
    campaign_created: {
      labelBn: 'ক্যাম্পেইন তৈরি (PAUSED) — Boss Ads Manager-এ চালু করবেন',
      next: [],
      allowedTools: ['recommend_ad_actions'],
      status: 'done',
    },
  },
  cardSteps: {
    launch_campaign: {
      stage: 'campaign_approval',
      onExecuted: 'campaign_created',
      onExecutedStatus: 'done',
      onRejected: 'brief_ready',
      onRejectedStatus: 'active',
    },
    duplicate_campaign: {
      stage: 'campaign_approval',
      onExecuted: 'campaign_created',
      onExecutedStatus: 'done',
      onRejected: 'brief_ready',
      onRejectedStatus: 'active',
    },
    update_campaign_budget: { stage: 'campaign_approval', onExecuted: 'campaign_created', onExecutedStatus: 'done' },
    pause_campaign: { stage: 'campaign_approval', onExecuted: 'campaign_created', onExecutedStatus: 'done' },
    ad_budget: { stage: 'campaign_approval', onExecuted: 'campaign_created', onExecutedStatus: 'done' },
  },
}

// ── 3. Audience creation / lookalike ────────────────────────────────────────
const AUDIENCE: WorkflowTemplate = {
  kind: 'audience',
  titleBn: 'অডিয়েন্স তৈরি (retarget/lookalike)',
  entry: 'source_selected',
  routerPack: 'ads',
  steps: {
    source_selected: {
      labelBn: 'সোর্স/সেগমেন্ট বাছাই হচ্ছে',
      next: ['audience_approval'],
      allowedTools: [
        'list_audiences', 'get_customer_segments', 'get_customer_intelligence',
        'create_retargeting_audience', 'create_lookalike_audience',
      ],
    },
    audience_approval: {
      labelBn: 'অডিয়েন্স কার্ড Boss-এর অনুমোদনের অপেক্ষায়',
      next: ['audience_created', 'source_selected'],
      allowedTools: ['get_pending_approvals', 'list_audiences'],
      status: 'waiting_owner',
    },
    audience_created: {
      labelBn: 'অডিয়েন্স তৈরি হয়েছে',
      next: [],
      allowedTools: ['list_audiences'],
      status: 'done',
    },
  },
  cardSteps: {
    create_retargeting_audience: {
      stage: 'audience_approval',
      onExecuted: 'audience_created',
      onExecutedStatus: 'done',
      onRejected: 'source_selected',
      onRejectedStatus: 'active',
    },
    create_lookalike_audience: {
      stage: 'audience_approval',
      onExecuted: 'audience_created',
      onExecutedStatus: 'done',
      onRejected: 'source_selected',
      onRejectedStatus: 'active',
    },
  },
}

// ── 4. Staff task proposal → approval → dispatch → verification ─────────────
const STAFF_TASK: WorkflowTemplate = {
  kind: 'staff_task',
  titleBn: 'স্টাফ টাস্ক (proposal → approve → dispatch)',
  entry: 'proposal_ready',
  routerPack: 'staff_dispatch',
  steps: {
    proposal_ready: {
      labelBn: 'টাস্ক proposal তৈরি হচ্ছে',
      next: ['dispatch_approval'],
      allowedTools: [
        'prepare_staff_task_proposal', 'propose_staff_tasks', 'merge_into_proposal',
        'get_current_proposal', 'get_all_staff', 'add_staff_task_now',
        'send_staff_announcement', 'explain_staff_task_bangla',
      ],
    },
    dispatch_approval: {
      labelBn: 'Dispatch কার্ড Boss-এর অনুমোদনের অপেক্ষায়',
      next: ['dispatching', 'proposal_ready'],
      allowedTools: ['get_current_proposal', 'merge_into_proposal', 'get_pending_approvals'],
      status: 'waiting_owner',
    },
    dispatching: {
      labelBn: 'Telegram-এ পাঠানো হচ্ছে (worker)',
      next: ['dispatched'],
      allowedTools: ['get_dispatch_status'],
      status: 'waiting_worker',
    },
    dispatched: {
      labelBn: 'টাস্ক পাঠানো হয়েছে — অগ্রগতি দেখা যাবে get_staff_tasks-এ',
      next: [],
      allowedTools: ['get_dispatch_status', 'get_staff_tasks', 'update_staff_task_status'],
      status: 'done',
    },
  },
  cardSteps: {
    dispatch_staff_tasks: {
      stage: 'dispatch_approval',
      onApproved: 'dispatching',
      onExecuted: 'dispatched',
      onExecutedStatus: 'done',
      onRejected: 'proposal_ready',
      onRejectedStatus: 'active',
    },
    add_staff_task_now: {
      stage: 'dispatch_approval',
      onApproved: 'dispatching',
      onExecuted: 'dispatched',
      onExecutedStatus: 'done',
    },
    task_dispatch: {
      stage: 'dispatch_approval',
      onApproved: 'dispatching',
      onExecuted: 'dispatched',
      onExecutedStatus: 'done',
    },
    staff_announcement: {
      stage: 'dispatch_approval',
      onApproved: 'dispatching',
      onExecuted: 'dispatched',
      onExecutedStatus: 'done',
    },
  },
}

// ── 5. Expense / payroll / finance approval ─────────────────────────────────
const FINANCE_APPROVAL: WorkflowTemplate = {
  kind: 'finance_approval',
  titleBn: 'ফাইন্যান্স এন্ট্রি (approve → record)',
  entry: 'entry_drafted',
  routerPack: 'finance',
  steps: {
    entry_drafted: {
      labelBn: 'এন্ট্রি ড্রাফট হচ্ছে',
      next: ['entry_approval'],
      allowedTools: [
        'log_expense', 'log_expenses_batch', 'log_ledger_entry', 'log_ledger_entries_batch',
        'edit_finance_entry', 'delete_finance_entry',
        'get_expense_summary', 'get_ledger_balances', 'list_recent_transactions',
      ],
    },
    entry_approval: {
      labelBn: 'ফাইন্যান্স কার্ড Boss-এর অনুমোদনের অপেক্ষায়',
      next: ['recorded', 'entry_drafted'],
      allowedTools: ['get_pending_approvals', 'list_recent_transactions'],
      status: 'waiting_owner',
    },
    recorded: {
      labelBn: 'খাতায় উঠেছে (proof: entry id)',
      next: [],
      allowedTools: ['list_recent_transactions', 'get_ledger_balances'],
      status: 'done',
    },
  },
  cardSteps: Object.fromEntries(
    ['expense', 'ledger', 'log_expense', 'log_ledger_entry', 'edit_finance_entry', 'delete_finance_entry'].map(
      (t) => [t, {
        stage: 'entry_approval',
        onExecuted: 'recorded',
        onExecutedStatus: 'done' as WorkflowStatus,
        onRejected: 'entry_drafted',
        onRejectedStatus: 'active' as WorkflowStatus,
      }],
    ),
  ),
}

// ── 6. Browser-based external setup (durable session checkpoint, §H) ────────
const BROWSER_SETUP: WorkflowTemplate = {
  kind: 'browser_setup',
  titleBn: 'ব্রাউজার কাজ (লাইভ Chrome)',
  entry: 'session_active',
  routerPack: 'browser',
  steps: {
    session_active: {
      labelBn: 'লাইভ ব্রাউজারে কাজ চলছে',
      next: ['awaiting_owner', 'worker_approval', 'completed_proof'],
      allowedTools: [
        'live_browser_look', 'live_browser_act', 'live_browser_status',
        'run_browser_task', 'check_browser_task', 'list_browser_recipes', 'run_browser_recipe',
      ],
    },
    awaiting_owner: {
      labelBn: 'Boss-এর হাত লাগবে (login/OTP/সিদ্ধান্ত) — checkpoint করা আছে',
      next: ['resuming'],
      allowedTools: ['live_browser_look', 'live_browser_status'],
      status: 'waiting_owner',
    },
    // §H: resume ALWAYS begins by LOOKING at the existing tab — navigation to
    // the home page is not even exposed from this step.
    resuming: {
      labelBn: 'Resume — আগে live_browser_look দিয়ে এখনকার পেজ দেখো',
      next: ['session_active'],
      allowedTools: ['live_browser_look'],
      expectedTool: 'live_browser_look',
    },
    worker_approval: {
      labelBn: 'ব্রাউজার-টাস্ক কার্ড Boss-এর অনুমোদনের অপেক্ষায়',
      next: ['worker_running', 'session_active'],
      allowedTools: ['get_pending_approvals', 'check_browser_task'],
      status: 'waiting_owner',
    },
    worker_running: {
      labelBn: 'VPS worker ব্রাউজার-টাস্ক চালাচ্ছে',
      next: ['completed_proof'],
      allowedTools: ['check_browser_task'],
      status: 'waiting_worker',
    },
    completed_proof: {
      labelBn: 'কাজ শেষ — প্রমাণ (screenshot/রেকর্ড) আছে',
      next: [],
      allowedTools: ['live_browser_look'],
      status: 'done',
    },
  },
  cardSteps: {
    browser_action: {
      stage: 'worker_approval',
      onApproved: 'worker_running',
      onExecuted: 'completed_proof',
      onExecutedStatus: 'done',
    },
  },
}

// ── 7. Document/invoice extraction → ERP writeback ──────────────────────────
const DOC_EXTRACTION: WorkflowTemplate = {
  kind: 'doc_extraction',
  titleBn: 'ডকুমেন্ট/ইনভয়েস → ERP-তে তোলা',
  entry: 'document_received',
  routerPack: 'vision',
  steps: {
    document_received: {
      labelBn: 'ডকুমেন্ট পড়া হচ্ছে',
      next: ['extracted'],
      allowedTools: ['extract_invoice', 'read_screenshot', 'search_documents', 'get_document'],
    },
    extracted: {
      labelBn: 'ডেটা বের হয়েছে — এবার ERP-তে তোলার কার্ড',
      next: ['writeback_approval'],
      allowedTools: [
        'log_expense', 'log_expenses_batch', 'log_ledger_entry', 'log_ledger_entries_batch',
        'get_ledger_balances', 'list_recent_transactions',
      ],
      expectedTool: 'log_expense',
    },
    writeback_approval: {
      labelBn: 'Writeback কার্ড Boss-এর অনুমোদনের অপেক্ষায়',
      next: ['written_back', 'extracted'],
      allowedTools: ['get_pending_approvals'],
      status: 'waiting_owner',
    },
    written_back: {
      labelBn: 'ERP-তে উঠেছে (proof: entry id)',
      next: [],
      allowedTools: ['list_recent_transactions'],
      status: 'done',
    },
  },
  cardSteps: Object.fromEntries(
    ['expense', 'ledger', 'log_expense', 'log_ledger_entry'].map((t) => [t, {
      stage: 'writeback_approval',
      onExecuted: 'written_back',
      onExecutedStatus: 'done' as WorkflowStatus,
      onRejected: 'extracted',
      onRejectedStatus: 'active' as WorkflowStatus,
    }]),
  ),
}

export const WORKFLOW_TEMPLATES: Record<string, WorkflowTemplate> = {
  product_post: PRODUCT_POST,
  ad_campaign: AD_CAMPAIGN,
  audience: AUDIENCE,
  staff_task: STAFF_TASK,
  finance_approval: FINANCE_APPROVAL,
  browser_setup: BROWSER_SETUP,
  doc_extraction: DOC_EXTRACTION,
}

/**
 * Card type → template kinds that can own it, in ATTACH-PRIORITY order: an
 * active run of an earlier kind claims the card before a new run of a later
 * kind is created. (e.g. a log_expense card binds to an in-flight invoice
 * extraction before it would start a plain finance approval.)
 */
const CARD_TYPE_TEMPLATES: Record<string, string[]> = {
  image_gen: ['product_post'],
  fb_post: ['product_post'],
  instagram_post: ['product_post'],
  schedule_content: ['product_post'],
  launch_campaign: ['ad_campaign'],
  duplicate_campaign: ['ad_campaign'],
  update_campaign_budget: ['ad_campaign'],
  pause_campaign: ['ad_campaign'],
  ad_budget: ['ad_campaign'],
  create_retargeting_audience: ['audience'],
  create_lookalike_audience: ['audience'],
  dispatch_staff_tasks: ['staff_task'],
  add_staff_task_now: ['staff_task'],
  task_dispatch: ['staff_task'],
  staff_announcement: ['staff_task'],
  expense: ['doc_extraction', 'finance_approval'],
  ledger: ['doc_extraction', 'finance_approval'],
  log_expense: ['doc_extraction', 'finance_approval'],
  log_ledger_entry: ['doc_extraction', 'finance_approval'],
  edit_finance_entry: ['finance_approval'],
  delete_finance_entry: ['finance_approval'],
  browser_action: ['browser_setup'],
}

export function templateKindsForCardType(type: string): string[] {
  return CARD_TYPE_TEMPLATES[type] ?? []
}

export function getWorkflowTemplate(kind: string): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES[kind]
}

export function getTemplateStep(kind: string, state: string): WorkflowStepDef | undefined {
  return WORKFLOW_TEMPLATES[kind]?.steps[state]
}

/** nextAllowedTools for a template step (undefined for non-template runs). */
export function nextAllowedToolsFor(kind: string, state: string): string[] | undefined {
  return getTemplateStep(kind, state)?.allowedTools
}

/**
 * Card-driven transition for a template run: what step/status does this card
 * outcome move the run to? null = not a template card → caller keeps the
 * legacy Phase 4 behavior (executed→done, rejected→cancelled …).
 */
export function templateCardTransition(
  kind: string,
  cardType: string,
  outcome: 'executed' | 'rejected' | 'approved',
): { toState: string; toStatus: WorkflowStatus } | null {
  const tpl = WORKFLOW_TEMPLATES[kind]
  const cs = tpl?.cardSteps[cardType]
  if (!tpl || !cs) return null
  if (outcome === 'executed') return { toState: cs.onExecuted, toStatus: cs.onExecutedStatus }
  if (outcome === 'approved') {
    return cs.onApproved
      ? { toState: cs.onApproved, toStatus: tpl.steps[cs.onApproved]?.status ?? 'waiting_worker' }
      : null
  }
  // rejected
  return cs.onRejected
    ? { toState: cs.onRejected, toStatus: cs.onRejectedStatus ?? 'active' }
    : null
}

/** Resolve a step's expected mutating tool against the run's facts. */
export function expectedToolFor(
  kind: string,
  state: string,
  facts: Record<string, unknown> | null,
): string | null {
  const step = getTemplateStep(kind, state)
  if (!step?.expectedTool) return null
  if (step.requiresFacts?.some((k) => !(facts ?? {})[k])) return null
  return typeof step.expectedTool === 'function'
    ? step.expectedTool(facts ?? {})
    : step.expectedTool
}

/**
 * Roadmap §D per-phase tool_choice: bind the head's FIRST round to the step's
 * expected tool only when the situation is deterministic — exactly one active
 * template run, its step names one mutating tool, its required facts are
 * present, and the owner's message is a continuation (carries no new intent).
 */
export function workflowToolBinding(
  runs: Array<{ kind: string; state: string; status: string; facts: Record<string, unknown> | null }>,
  opts: { continuation: boolean },
): { toolName: string } | null {
  if (!opts.continuation) return null
  const active = runs.filter((r) => r.status === 'active' && WORKFLOW_TEMPLATES[r.kind])
  if (active.length !== 1) return null
  const tool = expectedToolFor(active[0].kind, active[0].state, active[0].facts)
  return tool ? { toolName: tool } : null
}
