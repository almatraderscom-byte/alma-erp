import { INVENTORY_ROWS } from '@/agent/tools/registry/inventory.data'
import type { InternalSectionId } from './internal-registry'

export type ToolReferenceClassification = 'extract' | 'section' | 'none'

/** Freeze the reviewed name set as well as its count. A tool added inside an
 * already-known domain must still stop CI until its semantics are reviewed. */
export const REVIEWED_ACTIVE_TOOL_FINGERPRINT = '360:jvgj7l'

export function activeToolInventoryFingerprint(
  rows: ReadonlyArray<{ name: string; domain?: string | null }>,
): string {
  const value = rows.map((row) => `${row.name}\u0000${row.domain ?? ''}`).sort().join('\u001f')
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${rows.length}:${(hash >>> 0).toString(36)}`
}

export interface ToolReferenceCoverageEntry {
  tool: string
  classification: ToolReferenceClassification
  reason: string
  extractorId?: ReferenceExtractorId
  fallbackSection?: InternalSectionId
}

export type ReferenceExtractorId =
  | 'orders'
  | 'employees'
  | 'attendance'
  | 'trading_accounts'
  | 'trading_trades'
  | 'pending_actions'
  | 'tool_screenshot'
  | 'staff'
  | 'staff_tasks'
  | 'owner_todos'
  | 'open_tasks'
  | 'products'
  | 'customers'
  | 'media_project'
  | 'creative_assets'
  | 'artifact'
  | 'web_research'
  | 'live_browser'
  | 'meta_objects'
  | 'calls'
  | 'agent_projects'
  | 'appointments'
  | 'bills'
  | 'reminders'
  | 'documents'
  | 'scheduled_calls'
  | 'plans'
  | 'workflow_runs'
  | 'growth'
  | 'trading_extended'
  | 'staff_extended'
  | 'delegation'

type DomainPolicy =
  | { classification: 'section'; section: InternalSectionId; reason: string }
  | { classification: 'none'; reason: string }

/**
 * Every inventory domain must be reviewed here. There is deliberately no
 * default: a newly introduced domain throws during module initialization and
 * fails the coverage test instead of silently becoming `none`.
 */
export const DOMAIN_REFERENCE_POLICY: Readonly<Record<string, DomainPolicy>> = {
  ads: { classification: 'section', section: 'agent_ads', reason: 'Ads workflow has a verified internal Ads/Growth fallback; exact provider objects require canonical provider URLs.' },
  advisor: { classification: 'section', section: 'insights', reason: 'Advisor output is aggregate guidance, so the verified Insights section is the honest destination.' },
  alerts: { classification: 'section', section: 'activity', reason: 'Alert tools surface operational activity without a stable exact record output.' },
  analytics: { classification: 'section', section: 'analytics', reason: 'Analytics outputs are aggregate reports, not one exact ERP record.' },
  appointments: { classification: 'none', reason: 'Appointment tools require an explicit reviewed output extractor; tools without one remain non-navigable.' },
  approvals: { classification: 'section', section: 'approvals', reason: 'Approval tools use the verified Approvals section unless an exact action id is extracted.' },
  artifacts: { classification: 'section', section: 'agent_home', reason: 'Artifact tools fall back to the authenticated Agent artifact surface.' },
  ask: { classification: 'none', reason: 'ask_user produces an in-chat card, not a navigation destination.' },
  autonomy: { classification: 'section', section: 'agent_staff_monitor', reason: 'Autonomy controls are reviewed/observed in Staff Monitor.' },
  bills: { classification: 'none', reason: 'Bill tools require an explicit reviewed output extractor; tools without one remain non-navigable.' },
  brand: { classification: 'section', section: 'creative_studio', reason: 'Brand assets are managed from Creative Studio.' },
  briefing: { classification: 'section', section: 'briefing', reason: 'Briefing output maps to the verified Briefing section.' },
  browser: { classification: 'section', section: 'agent_browser_live', reason: 'Browser jobs map to the verified Live Browser section.' },
  calls: { classification: 'section', section: 'phone_calls', reason: 'Call operations map to the Phone Console call history.' },
  camera: { classification: 'section', section: 'agent_live_watch', reason: 'Camera/watch operations are observable in Live Watch.' },
  campaign: { classification: 'section', section: 'agent_growth', reason: 'Campaign plans have an internal Growth fallback unless a provider canonical URL is returned.' },
  competitor: { classification: 'section', section: 'agent_growth', reason: 'Competitor research belongs to Growth; external results are extracted when present.' },
  content: { classification: 'section', section: 'creative_studio', reason: 'Content assets are managed in Creative Studio.' },
  core: { classification: 'none', reason: 'Core control/time/discovery tools do not represent a navigable business object.' },
  cost: { classification: 'section', section: 'agent_costs', reason: 'Cost tools map to the authenticated Agent Costs section.' },
  coworker: { classification: 'section', section: 'agent_staff_monitor', reason: 'Coworker results are managed in Staff Monitor.' },
  creative: { classification: 'section', section: 'creative_studio', reason: 'Creative output maps to Creative Studio unless an exact asset is extracted.' },
  cs: { classification: 'section', section: 'crm', reason: 'Customer-service records fall back to CRM when no exact customer/product is proven.' },
  dates: { classification: 'none', reason: 'Important-date tools have no dedicated record route; reviewed 2026-08-23.' },
  diag: { classification: 'section', section: 'system_diagnostics', reason: 'Diagnostics output maps to System Diagnostics.' },
  documents: { classification: 'section', section: 'agent_home', reason: 'Document tools use the Agent surface unless a durable document id is explicitly extracted.' },
  erp: { classification: 'section', section: 'dashboard', reason: 'Mixed ERP tools use a conservative Dashboard fallback unless explicitly overridden.' },
  family: { classification: 'none', reason: 'Family contacts/calls have no internal ERP record route; reviewed 2026-08-23.' },
  finance: { classification: 'section', section: 'finance', reason: 'Finance aggregates map to Finance unless an exact expense is extracted.' },
  gbp: { classification: 'section', section: 'agent_growth', reason: 'Google Business Profile work belongs to Growth; provider URLs are extracted only when returned.' },
  growth: { classification: 'section', section: 'agent_growth', reason: 'Growth tools map to the verified Growth section.' },
  health: { classification: 'none', reason: 'Personal health records have no dedicated authenticated screen; reviewed 2026-08-23.' },
  live_browser: { classification: 'section', section: 'agent_live_watch', reason: 'Live browser operations map to Live Watch and extract the observed final URL when present.' },
  location: { classification: 'none', reason: 'Location helpers return coordinates/context, not an owned record destination.' },
  mac: { classification: 'section', section: 'agent_mac', reason: 'Mac-agent operations map to the Mac remote-control section.' },
  marketing: { classification: 'section', section: 'agent_growth', reason: 'Marketing plans/reports map to Growth.' },
  memory: { classification: 'none', reason: 'Memory rows are intentionally not directly navigable from model output.' },
  meta_ads: { classification: 'section', section: 'agent_ads', reason: 'Meta tools fall back to Ads center; exact Ads Manager links require returned/observed canonical URLs plus account and object ids.' },
  orchestrator: { classification: 'none', reason: 'Delegation is a transport wrapper; it propagates child references instead of minting a destination.' },
  personal: { classification: 'none', reason: 'Personal helper output has no stable record route; reviewed 2026-08-23.' },
  plan: { classification: 'section', section: 'agent_home', reason: 'Plans are visible from the Agent workspace.' },
  playbook: { classification: 'section', section: 'agent_staff_monitor', reason: 'Playbooks and learned operations are reviewed from Agent monitor surfaces.' },
  push: { classification: 'section', section: 'settings_notifications', reason: 'Push configuration maps to Notification settings.' },
  qc: { classification: 'section', section: 'creative_studio', reason: 'Creative QC belongs to Creative Studio.' },
  reference: { classification: 'section', section: 'creative_studio', reason: 'Creative reference library belongs to Creative Studio.' },
  reminders: { classification: 'none', reason: 'Reminder tools require an explicit reviewed output extractor; tools without one remain non-navigable.' },
  research: { classification: 'section', section: 'agent_growth', reason: 'Research falls back to Growth and extracts trusted external result URLs.' },
  salah: { classification: 'none', reason: 'Salah state has no record navigation destination and remains conversational.' },
  seo: { classification: 'section', section: 'agent_growth', reason: 'SEO operations map to Growth.' },
  settings: { classification: 'section', section: 'settings_session', reason: 'Agent settings map to Session settings.' },
  simulate: { classification: 'none', reason: 'Simulation output is ephemeral and has no persistent destination.' },
  skills: { classification: 'section', section: 'agent_staff_monitor', reason: 'Skill lifecycle is reviewed from Agent monitor surfaces.' },
  social: { classification: 'section', section: 'agent_growth', reason: 'Social publishing/research maps to Growth; provider permalinks are extracted only when returned.' },
  staff: { classification: 'section', section: 'agent_staff_monitor', reason: 'Staff operations map to Staff Monitor unless exact staff/task ids are extracted.' },
  studio: { classification: 'section', section: 'creative_studio', reason: 'Studio operations map to Creative Studio.' },
  tasking: { classification: 'section', section: 'task_spotlight', reason: 'Operational tasking maps to Task Spotlight.' },
  todo: { classification: 'section', section: 'agent_home', reason: 'Owner todos are visible from the Agent workspace.' },
  trading: { classification: 'section', section: 'trading_home', reason: 'Trading tools map to the Trading surface unless exact account/trade ids are extracted.' },
  tryon: { classification: 'section', section: 'creative_studio', reason: 'Try-on output belongs to Creative Studio.' },
  vision: { classification: 'section', section: 'creative_studio', reason: 'Vision/image output belongs to Creative Studio.' },
  wa: { classification: 'section', section: 'agent_whatsapp', reason: 'WhatsApp tools map to the authenticated WhatsApp section.' },
  website: { classification: 'section', section: 'agent_growth', reason: 'Website operations map to Growth and only returned external URLs become external references.' },
  workbench: { classification: 'section', section: 'agent_mac', reason: 'Workbench jobs map to Mac remote control.' },
  worktodo: { classification: 'section', section: 'task_spotlight', reason: 'Work todos map to Task Spotlight.' },
}

type ExtractOverride = {
  extractorId: ReferenceExtractorId
  fallbackSection?: InternalSectionId
  reason: string
}

/** Tool/output-path extractors are named explicitly; no arbitrary nested-id scan. */
export const TOOL_EXTRACT_OVERRIDES: Readonly<Record<string, ExtractOverride>> = {
  get_orders: { extractorId: 'orders', fallbackSection: 'orders', reason: 'Extract data.orders[].id.' },
  get_customer_order_status: { extractorId: 'orders', fallbackSection: 'orders', reason: 'Extract only data.orders[] rows whose source is erp.' },
  check_order_issues: { extractorId: 'orders', fallbackSection: 'orders', reason: 'Extract data.issues[].orderEntities[].id.' },
  update_order: { extractorId: 'orders', fallbackSection: 'orders', reason: 'Extract data.orderEntities[].id from the verified write result.' },
  update_orders: { extractorId: 'orders', fallbackSection: 'orders', reason: 'Extract data.orderEntities[].id from the verified write result.' },
  order_lifecycle_scan: { extractorId: 'orders', fallbackSection: 'orders', reason: 'Extract data.orderEntities[].id.' },
  get_employee_overview: { extractorId: 'employees', fallbackSection: 'employees', reason: 'Extract data.employees[].id with explicit business namespace.' },
  get_attendance: { extractorId: 'attendance', fallbackSection: 'attendance', reason: 'Extract known employee/attendance arrays with explicit business namespace.' },
  get_trading_accounts: { extractorId: 'trading_accounts', fallbackSection: 'trading_accounts', reason: 'Extract data.accounts[].id.' },
  get_trading_account_detail: { extractorId: 'trading_extended', fallbackSection: 'trading_accounts', reason: 'Extract data.account.id and data.recentTrades[].id.' },
  get_trading_trades_today: { extractorId: 'trading_trades', fallbackSection: 'trading_accounts', reason: 'Extract data.trades[].id and tradingAccountId.' },
  get_pending_approvals: { extractorId: 'pending_actions', fallbackSection: 'approvals', reason: 'Extract data.pending[].id.' },
  get_all_staff: { extractorId: 'staff', fallbackSection: 'agent_staff_monitor', reason: 'Extract data.staff[].id.' },
  get_staff_tasks: { extractorId: 'staff_tasks', fallbackSection: 'agent_staff_monitor', reason: 'Extract data.staffGroups[].tasks[].id and staff.id.' },
  add_staff_task_now: { extractorId: 'pending_actions', fallbackSection: 'agent_staff_monitor', reason: 'The stage result returns only data.pendingActionId, not a staff-task id.' },
  list_owner_todos: { extractorId: 'owner_todos', fallbackSection: 'agent_home', reason: 'Extract data.todos[].id.' },
  add_owner_todo: { extractorId: 'owner_todos', fallbackSection: 'agent_home', reason: 'Extract data.id.' },
  update_owner_todo: { extractorId: 'owner_todos', fallbackSection: 'agent_home', reason: 'Extract data.id when a concrete todo is returned.' },
  track_open_task: { extractorId: 'open_tasks', fallbackSection: 'agent_home', reason: 'Extract data.id/openTaskId.' },
  resolve_open_task: { extractorId: 'open_tasks', fallbackSection: 'agent_home', reason: 'Extract data.id/openTaskId.' },
  get_product: { extractorId: 'products', fallbackSection: 'inventory', reason: 'Extract only verified LifestyleProduct SKU fields; image-catalog groups are omitted.' },
  get_product_details: { extractorId: 'products', fallbackSection: 'inventory', reason: 'Extract data.code or data.members[].code as product SKUs, never stock variants.' },
  search_products: { extractorId: 'products', fallbackSection: 'inventory', reason: 'Extract data.products[] exact identifiers.' },
  get_customer_summary: { extractorId: 'customers', fallbackSection: 'crm', reason: 'Extract data.customers[].id.' },
  get_customer_intelligence: { extractorId: 'customers', fallbackSection: 'crm', reason: 'Extract returned CS-customer ids into the distinct cs_customer namespace.' },
  get_media_project: { extractorId: 'media_project', fallbackSection: 'agent_media', reason: 'Extract data.project.id and its explicit pendingActionId when present.' },
  list_creative_studio_assets: { extractorId: 'creative_assets', fallbackSection: 'creative_studio', reason: 'Extract only gallery AgentPendingAction ids; omit signed URLs and unrelated model/product rows.' },
  save_artifact: { extractorId: 'artifact', fallbackSection: 'agent_home', reason: 'Extract data.artifactId/id and use authenticated artifact viewer.' },
  web_research: { extractorId: 'web_research', fallbackSection: 'agent_growth', reason: 'Extract search result URLs and fetched verified/final URL output fields.' },
  live_browser_look: { extractorId: 'live_browser', fallbackSection: 'agent_live_watch', reason: 'Extract the browser-observed page URL.' },
  live_browser_act: { extractorId: 'live_browser', fallbackSection: 'agent_live_watch', reason: 'Extract the post-action browser-observed page URL.' },
  get_call_history: { extractorId: 'calls', fallbackSection: 'phone_calls', reason: 'Extract data.calls[].id.' },
  list_agent_projects: { extractorId: 'agent_projects', fallbackSection: 'agent_home', reason: 'Extract returned project ids.' },
  add_appointment: { extractorId: 'appointments', fallbackSection: 'agent_home', reason: 'Extract the returned durable appointment id.' },
  list_appointments: { extractorId: 'appointments', fallbackSection: 'agent_home', reason: 'Extract data.appointments[].id.' },
  update_appointment: { extractorId: 'appointments', fallbackSection: 'agent_home', reason: 'Extract the returned durable appointment id.' },
  add_bill: { extractorId: 'bills', fallbackSection: 'agent_home', reason: 'Extract the returned durable bill id.' },
  list_bills: { extractorId: 'bills', fallbackSection: 'agent_home', reason: 'Extract data.bills[].id.' },
  mark_bill_paid: { extractorId: 'bills', fallbackSection: 'agent_home', reason: 'Extract the updated durable bill id.' },
  update_bill: { extractorId: 'bills', fallbackSection: 'agent_home', reason: 'Extract the updated durable bill id.' },
  delete_bill: { extractorId: 'bills', fallbackSection: 'agent_home', reason: 'Extract the soft-deactivated bill id so the focus screen can show deleted state.' },
  set_reminder: { extractorId: 'reminders', fallbackSection: 'agent_home', reason: 'Extract the returned durable reminder id; tier-3 pending actions are not misclassified.' },
  list_reminders: { extractorId: 'reminders', fallbackSection: 'agent_home', reason: 'Extract ids from the returned reminder array.' },
  cancel_reminder: { extractorId: 'reminders', fallbackSection: 'agent_home', reason: 'Extract the updated reminder id.' },
  snooze_reminder: { extractorId: 'reminders', fallbackSection: 'agent_home', reason: 'Extract the updated reminder id.' },
  save_document: { extractorId: 'documents', fallbackSection: 'agent_home', reason: 'Extract the returned durable document id; never persist its signed download URL.' },
  search_documents: { extractorId: 'documents', fallbackSection: 'agent_home', reason: 'Extract data.documents[].id.' },
  get_document: { extractorId: 'documents', fallbackSection: 'agent_home', reason: 'Extract the returned durable document id; never persist its signed download URL.' },
  list_scheduled_calls: { extractorId: 'scheduled_calls', fallbackSection: 'phone_calls', reason: 'Extract ids from the returned scheduled-call array.' },
  cancel_scheduled_call: { extractorId: 'scheduled_calls', fallbackSection: 'phone_calls', reason: 'Extract the cancelled scheduled-call id.' },
  place_agent_call: { extractorId: 'calls', fallbackSection: 'phone_calls', reason: 'Extract data.callRecordId from the durable call row.' },
  place_business_call: { extractorId: 'calls', fallbackSection: 'phone_calls', reason: 'Extract data.callRecordId from the durable business-call row.' },
  run_content_post: { extractorId: 'pending_actions', fallbackSection: 'approvals', reason: 'Extract data.gate1Id for the first durable approval gate.' },
  save_task_checkpoint: { extractorId: 'open_tasks', fallbackSection: 'agent_home', reason: 'Extract data.checkpointId for the durable open-task checkpoint.' },
  make_plan: { extractorId: 'plans', fallbackSection: 'agent_home', reason: 'Extract the returned durable data.plan_id.' },
  get_plan: { extractorId: 'plans', fallbackSection: 'agent_home', reason: 'Extract the requested durable data.plan_id.' },
  execute_plan: { extractorId: 'plans', fallbackSection: 'agent_home', reason: 'Extract the executed durable data.plan_id.' },
  start_fix_campaign: { extractorId: 'plans', fallbackSection: 'agent_home', reason: 'Extract the campaign data.plan_id.' },
  scan_business_signals: { extractorId: 'plans', fallbackSection: 'agent_home', reason: 'Extract only data.created[].planId from persisted plans.' },
  get_workflow_history: { extractorId: 'workflow_runs', fallbackSection: 'agent_home', reason: 'Extract data.run.id and data.runs[].id from durable workflow history.' },
  get_trading_dashboard: { extractorId: 'trading_extended', fallbackSection: 'trading_home', reason: 'Extract data.accountPerformance[].id.' },
  get_volume_targets: { extractorId: 'trading_extended', fallbackSection: 'trading_accounts', reason: 'Extract data.targets/accounts[].accountId.' },
  get_merchant_progress: { extractorId: 'trading_extended', fallbackSection: 'trading_accounts', reason: 'Extract data.accounts[].accountId.' },
  get_trading_employee_reports: { extractorId: 'trading_extended', fallbackSection: 'trading_accounts', reason: 'Extract only data.rows[].accountIds[] exact account ids.' },
  get_trading_daily_summary: { extractorId: 'trading_extended', fallbackSection: 'trading_home', reason: 'Extract exact account/trade ids from the named nested digest envelopes.' },
  get_trading_bkash_summary: { extractorId: 'trading_extended', fallbackSection: 'trading_accounts', reason: 'Extract data.rows[].accountId.' },
  prepare_staff_task_proposal: { extractorId: 'staff_extended', fallbackSection: 'agent_staff_monitor', reason: 'Extract explicit staffId fields and the returned pendingActionId.' },
  get_dispatch_status: { extractorId: 'staff_extended', fallbackSection: 'agent_staff_monitor', reason: 'Extract data.correctionContext[].staffId.' },
  send_dispatch_correction_notice: { extractorId: 'staff_extended', fallbackSection: 'agent_staff_monitor', reason: 'Extract correction staff ids and pending approval ids.' },
  get_shift_handover: { extractorId: 'staff_extended', fallbackSection: 'agent_staff_monitor', reason: 'Extract handover/trend/standing staffId fields.' },
  get_weekly_report_card: { extractorId: 'staff_extended', fallbackSection: 'agent_staff_monitor', reason: 'Extract data.card.perStaff[].staffId.' },
  check_website_seo_audit: { extractorId: 'artifact', fallbackSection: 'agent_growth', reason: 'Extract data.id as pending action and data.artifactCard.id only as a persisted artifact.' },
  meta_ads_get_ad_entities: { extractorId: 'meta_objects', fallbackSection: 'agent_ads', reason: 'Exact only with adAccountId + level + objectId + returned canonical URL.' },
  meta_ads_create_campaign: { extractorId: 'meta_objects', fallbackSection: 'agent_ads', reason: 'Extract its pending action; provider object is exact only with a returned canonical URL.' },
  meta_ads_create_ad_set: { extractorId: 'meta_objects', fallbackSection: 'agent_ads', reason: 'Extract its pending action; provider object is exact only with a returned canonical URL.' },
  meta_ads_create_ad: { extractorId: 'meta_objects', fallbackSection: 'agent_ads', reason: 'Extract its pending action; provider object is exact only with a returned canonical URL.' },
  pause_campaign: { extractorId: 'pending_actions', fallbackSection: 'agent_ads', reason: 'Extract the explicit durable data.pendingActionId.' },
  update_campaign_budget: { extractorId: 'pending_actions', fallbackSection: 'agent_ads', reason: 'Extract the explicit durable data.pendingActionId.' },
  duplicate_campaign: { extractorId: 'pending_actions', fallbackSection: 'agent_ads', reason: 'Extract the explicit durable data.pendingActionId.' },
  launch_campaign: { extractorId: 'pending_actions', fallbackSection: 'agent_ads', reason: 'Extract the explicit durable data.pendingActionId.' },
  create_retargeting_audience: { extractorId: 'pending_actions', fallbackSection: 'agent_ads', reason: 'Extract the explicit durable data.pendingActionId.' },
  create_lookalike_audience: { extractorId: 'pending_actions', fallbackSection: 'agent_ads', reason: 'Extract the explicit durable data.pendingActionId.' },
  recommend_ad_actions: { extractorId: 'pending_actions', fallbackSection: 'agent_ads', reason: 'Extract the explicit durable data.batchPendingActionId.' },
  draft_marketing_campaign: { extractorId: 'pending_actions', fallbackSection: 'agent_growth', reason: 'Extract the explicit durable data.pendingActionId.' },
  make_ad_creatives: { extractorId: 'pending_actions', fallbackSection: 'creative_studio', reason: 'Extract the explicit durable data.pendingActionId.' },
  request_standing_permission: { extractorId: 'pending_actions', fallbackSection: 'agent_staff_monitor', reason: 'Extract the explicit durable data.pendingActionId.' },
  check_autonomy: { extractorId: 'pending_actions', fallbackSection: 'agent_staff_monitor', reason: 'Extract only data.pendingPreview[].id; recent action ids are synthetic.' },
  request_agent_action: { extractorId: 'pending_actions', fallbackSection: 'agent_staff_monitor', reason: 'Extract the explicit AgentPendingAction data.id.' },
  run_browser_task: { extractorId: 'pending_actions', fallbackSection: 'agent_browser_live', reason: 'Extract the explicit durable data.pendingActionId.' },
  check_browser_task: { extractorId: 'pending_actions', fallbackSection: 'agent_browser_live', reason: 'Extract the verified AgentPendingAction data.id.' },
  start_cli_session: { extractorId: 'pending_actions', fallbackSection: 'agent_mac', reason: 'Extract the pending action returned by its permission-gated branch.' },
  drive_mac_app: { extractorId: 'pending_actions', fallbackSection: 'agent_mac', reason: 'Extract the pending action returned by its amber-policy branch.' },
  mac_desk_control: { extractorId: 'tool_screenshot', fallbackSection: 'agent_mac', reason: 'Mint the verified screenshot media reference from data.imageUrl, plus the pending action its amber-policy branch returns.' },
  get_office_camera_snapshot: { extractorId: 'tool_screenshot', fallbackSection: 'agent_live_watch', reason: 'The snapshot is returned for inline display as data.imageUrl; without a media reference the ON contract replaces the image with its alt text.' },
  run_mac_command: { extractorId: 'pending_actions', fallbackSection: 'agent_mac', reason: 'Extract the explicit durable data.pendingActionId.' },
  generate_image: { extractorId: 'pending_actions', fallbackSection: 'creative_studio', reason: 'Extract the explicit durable data.pendingActionId.' },
  post_to_facebook: { extractorId: 'pending_actions', fallbackSection: 'agent_growth', reason: 'Extract the explicit durable data.pendingActionId.' },
  publish_to_instagram: { extractorId: 'pending_actions', fallbackSection: 'agent_growth', reason: 'Extract the explicit durable data.pendingActionId.' },
  send_customer_message: { extractorId: 'pending_actions', fallbackSection: 'agent_growth', reason: 'Extract the explicit durable data.pendingActionId.' },
  reply_to_comment: { extractorId: 'pending_actions', fallbackSection: 'agent_growth', reason: 'Extract the explicit durable data.pendingActionId.' },
  add_subscription: { extractorId: 'pending_actions', fallbackSection: 'agent_costs', reason: 'Extract the explicit durable data.pendingActionId.' },
  log_expense: { extractorId: 'pending_actions', fallbackSection: 'finance', reason: 'Extract AgentPendingAction only; AgentFinanceExpense is not registry expense.' },
  log_ledger_entry: { extractorId: 'pending_actions', fallbackSection: 'finance', reason: 'Extract AgentPendingAction only; AgentFinanceLedger is not registry finance_entry.' },
  log_ledger_entries_batch: { extractorId: 'pending_actions', fallbackSection: 'finance', reason: 'Extract the explicit durable data.pendingActionId.' },
  log_expenses_batch: { extractorId: 'pending_actions', fallbackSection: 'finance', reason: 'Extract the explicit durable data.pendingActionId.' },
  delete_finance_entry: { extractorId: 'pending_actions', fallbackSection: 'finance', reason: 'Extract pending action only; the staged finance id belongs to a different model.' },
  edit_finance_entry: { extractorId: 'pending_actions', fallbackSection: 'finance', reason: 'Extract pending action only; the staged finance id belongs to a different model.' },
  draft_gbp_reply: { extractorId: 'pending_actions', fallbackSection: 'agent_growth', reason: 'Extract the explicit durable data.pendingActionId.' },
  draft_gbp_post: { extractorId: 'pending_actions', fallbackSection: 'agent_growth', reason: 'Extract the explicit durable data.pendingActionId.' },
  schedule_content: { extractorId: 'pending_actions', fallbackSection: 'agent_growth', reason: 'Extract the explicit durable data.pendingActionId.' },
  schedule_content_batch: { extractorId: 'pending_actions', fallbackSection: 'agent_growth', reason: 'Extract the explicit durable data.pendingActionId.' },
  plan_marketing: { extractorId: 'pending_actions', fallbackSection: 'agent_growth', reason: 'Extract the explicit durable data.pendingActionId.' },
  plan_media_video: { extractorId: 'media_project', fallbackSection: 'agent_media', reason: 'Extract data.projectId and data.pendingActionId as distinct durable rows.' },
  meta_ads_update_entity: { extractorId: 'meta_objects', fallbackSection: 'agent_ads', reason: 'Extract its pending action; provider object requires a canonical returned URL.' },
  meta_ads_catalog_create: { extractorId: 'meta_objects', fallbackSection: 'agent_ads', reason: 'Extract its pending action; provider object requires a canonical returned URL.' },
  meta_ads_activate_entity: { extractorId: 'meta_objects', fallbackSection: 'agent_ads', reason: 'Extract its pending action; provider object requires a canonical returned URL.' },
  manage_work_todos: { extractorId: 'owner_todos', fallbackSection: 'task_spotlight', reason: 'Extract named todo arrays/root id and the remove-branch pending action.' },
  call_family_member: { extractorId: 'pending_actions', fallbackSection: 'phone_calls', reason: 'Extract the explicit durable data.pendingActionId.' },
  schedule_call: { extractorId: 'pending_actions', fallbackSection: 'phone_calls', reason: 'Extract the staged call data.pendingActionId, not a ScheduledCall id.' },
  call_staff: { extractorId: 'pending_actions', fallbackSection: 'phone_calls', reason: 'Extract the explicit durable data.pendingActionId.' },
  send_urgent_alert: { extractorId: 'pending_actions', fallbackSection: 'phone_calls', reason: 'Extract the tier-three call data.pendingActionId.' },
  outbound_phone_call: { extractorId: 'pending_actions', fallbackSection: 'phone_calls', reason: 'Extract data.pendingActionId or data.existingActionId, never provider SID.' },
  preview_call_voice: { extractorId: 'pending_actions', fallbackSection: 'phone_calls', reason: 'Extract the explicit durable data.pendingActionId.' },
  get_outbound_call_status: { extractorId: 'pending_actions', fallbackSection: 'phone_calls', reason: 'Extract only data.calls[].pendingActionId; provider call SID is not an internal call id.' },
  dismiss_pending_approvals: { extractorId: 'pending_actions', fallbackSection: 'approvals', reason: 'Extract only the returned data.items[].id pending-action rows.' },
  run_website_seo_audit: { extractorId: 'pending_actions', fallbackSection: 'agent_growth', reason: 'Extract the explicit durable data.pendingActionId.' },
  draft_seo_fixes: { extractorId: 'pending_actions', fallbackSection: 'agent_growth', reason: 'Extract the explicit durable data.pendingActionId.' },
  change_product_slug: { extractorId: 'pending_actions', fallbackSection: 'agent_growth', reason: 'Extract the explicit durable data.pendingActionId.' },
  update_setting: { extractorId: 'pending_actions', fallbackSection: 'settings_session', reason: 'Extract the explicit durable data.pendingActionId.' },
  set_salah_override: { extractorId: 'pending_actions', reason: 'Extract the explicit durable data.pendingActionId.' },
  propose_staff_tasks: { extractorId: 'pending_actions', fallbackSection: 'agent_staff_monitor', reason: 'Extract its pending action; createMany does not return staff-task primary keys.' },
  merge_into_proposal: { extractorId: 'staff_tasks', fallbackSection: 'agent_staff_monitor', reason: 'Extract named staff-task ids and its explicit pending action.' },
  get_current_proposal: { extractorId: 'staff_tasks', fallbackSection: 'agent_staff_monitor', reason: 'Extract data.byStaff.<staff>[].id from the durable proposal rows.' },
  approve_pending_dispatch: { extractorId: 'staff_tasks', fallbackSection: 'agent_staff_monitor', reason: 'Extract data.taskIds[] and data.approvedActionId as distinct rows.' },
  correct_and_redispatch_staff_tasks: { extractorId: 'staff_tasks', fallbackSection: 'agent_staff_monitor', reason: 'Extract data.taskIds[] and the explicit pending action.' },
  approve_and_dispatch_tasks: { extractorId: 'pending_actions', fallbackSection: 'agent_staff_monitor', reason: 'Extract the explicit durable data.pendingActionId.' },
  update_staff_task_status: { extractorId: 'staff_tasks', fallbackSection: 'agent_staff_monitor', reason: 'Extract the verified durable staff-task data.id.' },
  set_staff_task_due: { extractorId: 'staff_tasks', fallbackSection: 'agent_staff_monitor', reason: 'Extract data.taskId from a successful verified update.' },
  explain_staff_task_bangla: { extractorId: 'staff_tasks', fallbackSection: 'agent_staff_monitor', reason: 'Extract only data.explained[].taskId; skipped ids may be unverified.' },
  get_marketing_history: { extractorId: 'staff_tasks', fallbackSection: 'agent_staff_monitor', reason: 'Extract only non-null data.products[].taskId AgentStaffTask foreign keys.' },
  send_staff_announcement: { extractorId: 'pending_actions', fallbackSection: 'agent_staff_monitor', reason: 'Extract the explicit durable data.pendingActionId.' },
  approve_pending_staff_message: { extractorId: 'pending_actions', fallbackSection: 'agent_staff_monitor', reason: 'Extract the explicit durable data.pendingActionId.' },
  run_creative_studio: { extractorId: 'pending_actions', fallbackSection: 'creative_studio', reason: 'Extract only data.queued[].pendingActionId from queued studio jobs.' },
  generate_on_model_image: { extractorId: 'pending_actions', fallbackSection: 'creative_studio', reason: 'Extract the explicit durable data.pendingActionId.' },
  generate_on_model_batch: { extractorId: 'pending_actions', fallbackSection: 'creative_studio', reason: 'Extract the explicit durable data.pendingActionIds array.' },
  make_product_reel: { extractorId: 'pending_actions', fallbackSection: 'creative_studio', reason: 'Extract the explicit durable data.pendingActionId.' },
  publish_product: { extractorId: 'pending_actions', fallbackSection: 'agent_growth', reason: 'Extract the explicit durable data.pendingActionId.' },
  unpublish_product: { extractorId: 'pending_actions', fallbackSection: 'agent_growth', reason: 'Extract the explicit durable data.pendingActionId.' },
  set_product_featured: { extractorId: 'pending_actions', fallbackSection: 'agent_growth', reason: 'Extract the explicit durable data.pendingActionId.' },
  update_product_web: { extractorId: 'pending_actions', fallbackSection: 'agent_growth', reason: 'Extract the explicit durable data.pendingActionId.' },
  edit_storefront_product: { extractorId: 'pending_actions', fallbackSection: 'agent_growth', reason: 'Extract the explicit durable data.pendingActionId.' },
  run_workbench_task: { extractorId: 'pending_actions', fallbackSection: 'agent_mac', reason: 'Extract the explicit durable data.pendingActionId.' },
  check_workbench_task: { extractorId: 'pending_actions', fallbackSection: 'agent_mac', reason: 'Extract the verified AgentPendingAction data.id.' },
  confirm_oxylabs_spend: { extractorId: 'pending_actions', fallbackSection: 'agent_costs', reason: 'Extract the explicit durable data.pendingActionId.' },
  generate_owner_briefing: { extractorId: 'orders', fallbackSection: 'briefing', reason: 'Extract only data.orderIssues[].orderEntities[].id.' },
  get_daily_digest: { extractorId: 'orders', fallbackSection: 'briefing', reason: 'Extract only data.business.orderIssues[].orderEntities[].id.' },
  get_customer_segments: { extractorId: 'customers', fallbackSection: 'crm', reason: 'Extract named CsCustomer arrays into the distinct cs_customer namespace.' },
  delete_document: { extractorId: 'documents', fallbackSection: 'agent_home', reason: 'Extract the returned durable document data.id.' },
  growth_brief_get: { extractorId: 'growth', fallbackSection: 'agent_growth', reason: 'Extract data.history[].id or data.brief.id as growth recommendations.' },
  growth_brief_draft: { extractorId: 'growth', fallbackSection: 'agent_growth', reason: 'Extract the returned durable growth-brief data.id.' },
  growth_brief_approve: { extractorId: 'growth', fallbackSection: 'agent_growth', reason: 'Extract the returned durable growth-brief data.id.' },
  get_ad_recommendations: { extractorId: 'growth', fallbackSection: 'agent_ads', reason: 'Extract only data.events[].id as internal ads-event rows.' },
  resolve_ad_recommendation: { extractorId: 'growth', fallbackSection: 'agent_ads', reason: 'Extract only data.event.id as an internal ads-event row.' },
  delegate_to_specialist: { extractorId: 'delegation', reason: 'Propagate validated child references and extract only the explicit pendingActionId.' },
}

function buildCoverage(): ToolReferenceCoverageEntry[] {
  const entries: ToolReferenceCoverageEntry[] = []
  for (const row of INVENTORY_ROWS) {
    const override = TOOL_EXTRACT_OVERRIDES[row.name]
    if (override) {
      entries.push({
        tool: row.name,
        classification: 'extract',
        extractorId: override.extractorId,
        fallbackSection: override.fallbackSection,
        reason: override.reason,
      })
      continue
    }
    const domain = row.domain
    if (!domain || !Object.prototype.hasOwnProperty.call(DOMAIN_REFERENCE_POLICY, domain)) {
      throw new Error(`Unclassified reference domain for active tool ${row.name}: ${String(domain)}`)
    }
    const policy = DOMAIN_REFERENCE_POLICY[domain]
    entries.push(policy.classification === 'section'
      ? {
          tool: row.name,
          classification: 'section',
          fallbackSection: policy.section,
          reason: policy.reason,
        }
      : { tool: row.name, classification: 'none', reason: policy.reason })
  }
  return entries
}

export const TOOL_REFERENCE_COVERAGE: readonly ToolReferenceCoverageEntry[] = buildCoverage()

const activeFingerprint = activeToolInventoryFingerprint(INVENTORY_ROWS)
if (activeFingerprint !== REVIEWED_ACTIVE_TOOL_FINGERPRINT) {
  throw new Error(
    `Active tool inventory changed (${activeFingerprint}); review reference semantics and update the frozen fingerprint.`,
  )
}

const COVERAGE_BY_TOOL = new Map(TOOL_REFERENCE_COVERAGE.map((entry) => [entry.tool, entry]))

export function referenceCoverageForTool(toolName: string): ToolReferenceCoverageEntry | null {
  return COVERAGE_BY_TOOL.get(toolName) ?? null
}

export const TOOL_REFERENCE_COVERAGE_COUNTS = TOOL_REFERENCE_COVERAGE.reduce(
  (counts, entry) => ({ ...counts, [entry.classification]: counts[entry.classification] + 1 }),
  { extract: 0, section: 0, none: 0 } as Record<ToolReferenceClassification, number>,
)
