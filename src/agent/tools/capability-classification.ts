/**
 * Authored capability classification for EVERY executable agent tool (Phase 2).
 *
 * This is the single source of truth for what each tool IS:
 *   domain — business area (telemetry label + future router packs)
 *   mode   — read (pure), stage (creates an owner-approval card/draft/queued job;
 *            nothing takes effect until the owner approves), write (direct effect)
 *   risk   — impact class: high = money / public / external people / master switches
 *
 * approval / concurrency / idempotency / proof default from mode
 * (tool-contract.ts resolveClassification) and are only spelled out where a tool
 * deviates. routing defaults to 'group' (owner-head TOOL_GROUPS); 'mcp' =
 * external co-worker connector only; 'customer' = CS-1 customer surface only.
 *
 * RULES:
 *  1. Every new tool MUST add an entry here — capability-manifest.test.ts fails
 *     the build otherwise (both missing and orphan entries).
 *  2. mode 'stage' is ONLY for tools whose effect is gated behind an owner
 *     approval card — if the handler causes the effect directly, it is 'write'
 *     even when the effect feels small.
 */
import type { ToolClassification } from './tool-contract'

const read = (domain: string, risk: ToolClassification['risk'] = 'low'): ToolClassification => ({ domain, mode: 'read', risk })
const stage = (domain: string, risk: ToolClassification['risk'] = 'medium'): ToolClassification => ({ domain, mode: 'stage', risk })
const write = (domain: string, risk: ToolClassification['risk'] = 'low'): ToolClassification => ({ domain, mode: 'write', risk })

export const TOOL_CLASSIFICATION: Record<string, ToolClassification> = {
  // ── core / registry ────────────────────────────────────────────────────────
  get_current_datetime: read('core'),
  list_agent_projects: read('core'),

  // ── memory (pgvector + graph) ──────────────────────────────────────────────
  save_memory: write('memory'),
  search_memory: read('memory'),
  update_memory: write('memory'),
  delete_memory: write('memory', 'medium'),
  graph_remember: write('memory'),
  graph_recall: read('memory'),

  // ── open tasks / checkpoints ───────────────────────────────────────────────
  track_open_task: write('tasking'),
  resolve_open_task: write('tasking'),
  save_task_checkpoint: write('tasking'),

  // ── VPS browser worker + recipes ───────────────────────────────────────────
  run_browser_task: stage('browser'),
  check_browser_task: read('browser'),
  list_browser_recipes: read('browser'),
  run_browser_recipe: stage('browser'),
  save_learned_recipe: write('browser'),

  // ── native push ────────────────────────────────────────────────────────────
  set_native_push: write('push'),
  test_native_push: { domain: 'push', mode: 'write', risk: 'low', proof: 'external' },

  // ── live browser (owner's own Chrome) ─────────────────────────────────────
  set_live_browser: write('live_browser', 'medium'),
  live_browser_pair: write('live_browser'),
  live_browser_status: read('live_browser'),
  live_browser_look: read('live_browser'),
  live_browser_act: { domain: 'live_browser', mode: 'write', risk: 'high', proof: 'external' },
  live_browser_trust: write('live_browser', 'medium'),
  browser_diagnose: read('live_browser'),
  growth_control_room: read('marketing'),

  // ── VPS workbench ──────────────────────────────────────────────────────────
  run_workbench_task: stage('workbench'),
  check_workbench_task: read('workbench'),

  // ── skill packs ────────────────────────────────────────────────────────────
  start_skill_pack: write('skills'),
  complete_skill_pack_run: write('skills'),

  // ── SEO audit engine ───────────────────────────────────────────────────────
  run_website_seo_audit: stage('seo', 'low'),
  check_website_seo_audit: read('seo'),

  // ── artifacts ──────────────────────────────────────────────────────────────
  save_artifact: write('artifacts'),

  // ── ERP reads ──────────────────────────────────────────────────────────────
  get_sales_summary: read('erp'),
  get_orders: read('erp'),
  get_inventory_status: read('erp'),
  get_product: read('erp'),
  get_customer_summary: read('erp'),
  get_employee_overview: read('erp'),
  get_attendance: read('erp'),
  get_dashboard_snapshot: read('erp'),
  analyze_returns: read('erp'),
  analyze_pricing: read('erp'),
  get_customer_segments: read('erp'),
  get_reorder_suggestions: read('erp'),
  check_order_issues: read('erp'),
  generate_owner_briefing: read('erp'),
  recall_business_knowledge: read('erp'),
  get_strategic_review: read('erp'),
  get_marketing_intel: read('erp'),
  get_pending_approvals: read('approvals'),
  dismiss_pending_approvals: write('approvals', 'medium'),
  order_lifecycle_scan: read('erp'),

  // ── social (Facebook / Instagram / Messenger via Meta Graph) ──────────────
  generate_image: stage('creative'),
  post_to_facebook: stage('social', 'high'),
  publish_to_instagram: stage('social', 'high'),
  send_customer_message: stage('social', 'high'),
  get_fb_recent_posts: read('social'),
  get_fb_messenger_inbox: read('social'),
  get_unanswered_comments: read('social'),
  reply_to_comment: stage('social', 'high'),

  // ── business WhatsApp (Twilio) ─────────────────────────────────────────────
  send_whatsapp: { domain: 'wa', mode: 'write', risk: 'high', proof: 'external' },
  get_wa_inbox: read('wa'),
  whatsapp_call: { domain: 'wa', mode: 'write', risk: 'high', proof: 'external' },

  // ── staff tasks / dispatch ─────────────────────────────────────────────────
  prepare_staff_task_proposal: stage('staff', 'low'),
  get_all_staff: read('staff'),
  get_staff_tasks: read('staff'),
  propose_staff_tasks: stage('staff', 'low'),
  merge_into_proposal: stage('staff', 'low'),
  approve_pending_dispatch: { domain: 'staff', mode: 'write', risk: 'high', proof: 'external' },
  approve_pending_staff_message: { domain: 'staff', mode: 'write', risk: 'high', proof: 'external' },
  get_dispatch_status: read('staff'),
  get_lunch_status: read('staff'),
  set_staff_leave: write('staff', 'medium'),
  list_staff_leave: read('staff'),
  get_current_proposal: read('staff'),
  correct_and_redispatch_staff_tasks: stage('staff', 'high'),
  approve_and_dispatch_tasks: stage('staff'),
  add_staff_task_now: write('staff', 'medium'),
  send_dispatch_correction_notice: stage('staff'),
  send_staff_announcement: stage('staff'),
  call_staff: stage('staff', 'high'),
  update_staff_task_status: write('staff'),
  set_staff_task_due: { domain: 'staff', mode: 'write', risk: 'medium', proof: 'external' },
  update_staff_task_profile: write('staff'),
  explain_staff_task_bangla: write('staff'),
  get_shift_handover: read('staff'),
  get_weekly_report_card: read('staff'),
  get_marketing_history: read('marketing'),

  // ── settings ───────────────────────────────────────────────────────────────
  update_setting: write('settings', 'medium'),
  get_settings: read('settings'),

  // ── salah ──────────────────────────────────────────────────────────────────
  set_salah_override: stage('salah', 'low'),
  get_prayer_times: read('salah'),
  get_salah_status: read('salah'),
  mark_salah: write('salah'),
  get_salah_weekly_summary: read('salah'),
  request_salah_delay: write('salah'),
  set_salah_time: write('salah'),
  get_salah_time_config: read('salah'),

  // ── personal finance ───────────────────────────────────────────────────────
  log_expense: stage('finance'),
  log_expenses_batch: stage('finance'),
  log_ledger_entry: stage('finance'),
  log_ledger_entries_batch: stage('finance'),
  get_expense_summary: read('finance'),
  get_ledger_balances: read('finance'),
  list_recent_transactions: read('finance'),
  delete_finance_entry: stage('finance', 'high'),
  edit_finance_entry: stage('finance'),
  get_financial_health: read('finance'),
  cashflow_forecast: read('finance'),

  // ── customer intelligence (owner-facing) ───────────────────────────────────
  get_customer_intelligence: read('cs'),
  cs_autonomy_status: read('cs'),

  // ── API cost tracking ──────────────────────────────────────────────────────
  set_api_credit: write('cost'),
  get_api_balances: read('cost'),
  list_subscriptions: read('cost'),
  add_subscription: stage('cost', 'low'),

  // ── reminders / alerts / calls ─────────────────────────────────────────────
  set_reminder: write('reminders'),
  list_reminders: read('reminders'),
  cancel_reminder: write('reminders'),
  snooze_reminder: write('reminders'),
  send_urgent_alert: { domain: 'alerts', mode: 'write', risk: 'high', proof: 'external' },
  get_outbound_call_status: read('calls'),
  preview_call_voice: write('calls'),
  outbound_phone_call: stage('calls', 'high'),
  place_agent_call: stage('calls', 'high'),

  // ── ask card ───────────────────────────────────────────────────────────────
  ask_user: { domain: 'ask', mode: 'write', risk: 'low', idempotency: 'required', concurrency: 'sequential' },

  // ── Meta ads ───────────────────────────────────────────────────────────────
  pause_campaign: stage('ads', 'high'),
  update_campaign_budget: stage('ads', 'high'),
  duplicate_campaign: stage('ads', 'high'),
  launch_campaign: stage('ads', 'high'),
  recommend_ad_actions: read('ads'),
  list_audiences: read('ads'),
  create_retargeting_audience: stage('ads'),
  create_lookalike_audience: stage('ads'),

  // ── marketing analysis ─────────────────────────────────────────────────────
  plan_marketing: read('marketing'),
  marketing_report: read('marketing'),

  // ── staff location (owner only) ────────────────────────────────────────────
  get_staff_location: read('location'),
  get_staff_location_history: read('location'),

  // ── office cameras ─────────────────────────────────────────────────────────
  get_office_camera_snapshot: read('camera'),
  camera_speak: { domain: 'camera', mode: 'write', risk: 'medium', proof: 'external' },

  // ── website (almatraders.com) ──────────────────────────────────────────────
  get_design_group: read('website'),
  get_size_for_age: read('website'),
  fetch_website_page: read('website'),
  get_website_catalog: read('website'),
  get_website_health: read('website'),
  publish_product: stage('website'),
  unpublish_product: stage('website'),
  set_product_featured: stage('website', 'low'),
  update_product_web: stage('website'),

  // ── web research (Oxylabs credits) ─────────────────────────────────────────
  confirm_oxylabs_spend: stage('research', 'low'),
  web_research: read('research', 'medium'),
  research_seo_keywords: read('research', 'medium'),

  // ── SEO (on-page + rank tracking) ──────────────────────────────────────────
  audit_product_seo: read('seo'),
  draft_seo_fixes: stage('seo'),
  track_keyword: write('seo'),
  list_tracked_keywords: read('seo'),
  untrack_keyword: write('seo'),
  submit_to_indexnow: { domain: 'seo', mode: 'write', risk: 'low', proof: 'external' },

  // ── Phase 41–48 growth operating system ────────────────────────────────────
  marketing_capability_audit: read('marketing'),
  growth_brief_get: read('marketing'),
  // Draft version rows are internal strategy memory (no external effect);
  // approve freezes the active strategy — direct write, owner-confirmed input.
  growth_brief_draft: write('marketing'),
  growth_brief_approve: write('marketing', 'medium'),
  growth_strategy_run: read('marketing'),
  marketing_attribution_report: read('marketing'),
  utm_build: read('marketing'),
  // Sends ONLY Events Manager test events (test code mandatory) — external but harmless.
  marketing_capi_test_event: { domain: 'marketing', mode: 'write', risk: 'low', proof: 'external' },
  growth_experiment: write('marketing'),
  creative_matrix: read('marketing'),
  content_calendar_health: read('marketing'),
  cro_brief_draft: read('marketing'),
  social_ops_health: read('marketing'),
  ads_campaign_plan: read('ads'),
  seo_technical_audit: read('seo'),
  seo_content_clusters: read('seo'),
  seo_release_plan: read('seo'),

  // ── analytics (GSC / GA4) ──────────────────────────────────────────────────
  get_search_console_performance: read('analytics'),
  get_indexing_status: read('analytics'),
  get_ga4_report: read('analytics'),

  // ── owned-audience campaigns (email/SMS) ───────────────────────────────────
  draft_marketing_campaign: stage('campaign', 'high'),

  // ── Google Business Profile ────────────────────────────────────────────────
  get_gbp_reviews: read('gbp'),
  draft_gbp_reply: stage('gbp', 'high'),
  draft_gbp_post: stage('gbp', 'high'),

  // ── Meta Ads MCP bridged reads (Phase MA1) — official mcp.facebook.com/ads ─
  // Read-only slice only; the 6 write tools arrive in MA3 behind approval cards
  // (capability map: src/agent/lib/meta-mcp/bridge.ts).
  meta_ads_list_tools: read('meta_ads'),
  meta_ads_get_ad_accounts: read('meta_ads'),
  meta_ads_get_ad_entities: read('meta_ads'),
  meta_ads_get_pages_for_business: read('meta_ads'),
  meta_ads_catalog_get_catalogs: read('meta_ads'),
  meta_ads_catalog_get_details: read('meta_ads'),
  meta_ads_catalog_get_diagnostics: read('meta_ads'),
  meta_ads_catalog_get_feed_rules: read('meta_ads'),
  meta_ads_catalog_get_product_details: read('meta_ads'),
  meta_ads_catalog_get_product_feed_details: read('meta_ads'),
  meta_ads_catalog_get_product_set_products: read('meta_ads'),
  meta_ads_catalog_get_product_sets: read('meta_ads'),
  meta_ads_catalog_get_products: read('meta_ads'),
  meta_ads_get_dataset_details: read('meta_ads'),
  meta_ads_get_dataset_quality: read('meta_ads'),
  meta_ads_get_dataset_stats: read('meta_ads'),
  meta_ads_get_errors: read('meta_ads'),
  meta_ads_insights_advertiser_context: read('meta_ads'),
  meta_ads_insights_anomaly_signal: read('meta_ads'),
  meta_ads_insights_auction_ranking_benchmarks: read('meta_ads'),
  meta_ads_insights_industry_benchmark: read('meta_ads'),
  meta_ads_insights_performance_trend: read('meta_ads'),
  meta_ads_get_opportunity_score: read('meta_ads'),
  meta_ads_get_help_article: read('meta_ads'),

  // ── Meta Ads MCP write tools (Phase MA3) — staged behind approval cards ─────
  // Creates/edits stage a card (mode 'stage' → staged_card); Meta makes entities
  // PAUSED. activate is the money switch — before_execute + HIGH risk.
  meta_ads_create_campaign: stage('meta_ads', 'high'),
  meta_ads_create_ad_set: stage('meta_ads', 'high'),
  meta_ads_create_ad: stage('meta_ads', 'high'),
  meta_ads_update_entity: stage('meta_ads', 'high'),
  meta_ads_catalog_create: stage('meta_ads', 'medium'),
  meta_ads_activate_entity: { domain: 'meta_ads', mode: 'stage', risk: 'high', approval: 'before_execute', proof: 'external' },

  // ── growth autopilot / content calendar ────────────────────────────────────
  schedule_content: stage('growth'),
  schedule_content_batch: stage('growth'),
  list_content_calendar: read('growth'),
  cancel_scheduled_content: write('growth', 'medium'),
  configure_growth_autopilot: write('growth', 'medium'),

  // ── competitors ────────────────────────────────────────────────────────────
  manage_competitor_watchlist: write('competitor'),
  research_competitor: read('competitor', 'medium'),
  research_competitor_creatives: read('competitor', 'medium'),

  // ── advisor ────────────────────────────────────────────────────────────────
  advisor_data_bundle: read('advisor'),

  // ── owner todos / digest ───────────────────────────────────────────────────
  add_owner_todo: write('todo'),
  list_owner_todos: read('todo'),
  update_owner_todo: write('todo'),
  get_daily_digest: read('briefing'),

  // ── playbook / learned rules ───────────────────────────────────────────────
  list_playbook: read('playbook'),
  approve_playbook: write('playbook', 'medium'),
  reject_playbook: write('playbook'),
  retire_playbook: write('playbook'),
  list_learned: read('playbook'),
  forget_rule: write('playbook', 'medium'),

  // ── creative reference library ─────────────────────────────────────────────
  list_reference_library: read('reference'),
  forget_reference: write('reference'),

  // ── QC / vision ────────────────────────────────────────────────────────────
  set_qc_level: write('qc'),
  qc_inspect_photo: read('vision'),
  extract_invoice: read('vision'),
  read_competitor_poster: read('vision'),
  read_screenshot: read('vision'),
  compare_to_brand: read('vision'),

  // ── simulation ─────────────────────────────────────────────────────────────
  simulate_outcome: read('simulate'),

  // ── try-on / creative studio ───────────────────────────────────────────────
  manage_model_library: write('tryon'),
  generate_on_model_image: stage('tryon'),
  generate_on_model_batch: stage('tryon'),
  run_creative_studio: stage('studio'),
  check_studio_job: read('studio'),

  // ── diagnostics ────────────────────────────────────────────────────────────
  run_health_scan: read('diag'),
  diagnose_issue: read('diag'),
  read_source_file: read('diag'),
  get_audit_summary: read('diag'),

  // ── content engine ─────────────────────────────────────────────────────────
  add_product_asset: write('content'),
  list_product_assets: read('content'),
  list_creative_studio_assets: read('content'),
  run_content_post: stage('content'),
  pause_content_engine: write('content', 'medium'),
  resume_content_engine: write('content', 'medium'),
  get_content_engine_status: read('content'),

  // ── external co-worker bridge (MCP connector only, never a head group) ─────
  request_agent_action: { domain: 'coworker', mode: 'stage', risk: 'low', routing: 'mcp' },

  // ── ad creatives / video ───────────────────────────────────────────────────
  make_ad_creatives: stage('creative'),
  make_product_reel: stage('creative'),
  save_brand_asset: write('brand'),

  // ── work todos / orchestration / plans ─────────────────────────────────────
  manage_work_todos: write('worktodo'),
  delegate_to_specialist: write('orchestrator', 'medium'),
  make_plan: write('plan'),
  execute_plan: write('plan', 'medium'),
  get_plan: read('plan'),
  get_workflow_history: read('plan'),
  get_duty_day: read('plan'),
  get_graph_health: read('plan'),

  // ── autonomy / heartbeat ───────────────────────────────────────────────────
  scan_business_signals: read('autonomy'),
  check_owner_silence: read('autonomy'),
  check_quiet_hours: read('autonomy'),
  get_action_cards: read('autonomy'),
  check_autonomy: read('autonomy'),
  set_autonomy_policy: write('autonomy', 'high'),
  undo_action: write('autonomy', 'medium'),
  heartbeat_control: write('autonomy', 'medium'),

  // ── personal life: bills / dates / briefing / calendar / health / documents ─
  add_bill: write('bills'),
  list_bills: read('bills'),
  mark_bill_paid: write('bills'),
  update_bill: write('bills'),
  delete_bill: write('bills'),
  add_important_date: write('dates'),
  list_important_dates: read('dates'),
  delete_important_date: write('dates'),
  get_personal_briefing: read('briefing'),
  add_appointment: write('appointments'),
  list_appointments: read('appointments'),
  update_appointment: write('appointments'),
  add_medication: write('health'),
  list_medications: read('health'),
  update_medication: write('health'),
  log_health: write('health'),
  list_health_logs: read('health'),
  save_document: write('documents'),
  search_documents: read('documents'),
  get_document: read('documents'),
  delete_document: write('documents', 'medium'),

  // ── ALMA Trading reads ─────────────────────────────────────────────────────
  get_trading_dashboard: read('trading'),
  get_trading_accounts: read('trading'),
  get_trading_account_detail: read('trading'),
  get_trading_trades_today: read('trading'),
  get_volume_targets: read('trading'),
  get_merchant_progress: read('trading'),
  get_trading_employee_reports: read('trading'),
  get_trading_daily_summary: read('trading'),
  get_trading_bkash_summary: read('trading'),
  list_trading_telegram_drafts: read('trading'),

  // ── family contacts / calls ────────────────────────────────────────────────
  add_family_contact: write('family'),
  list_family_contacts: read('family'),
  call_family_member: stage('family', 'high'),
  schedule_call: stage('family', 'high'),
  list_scheduled_calls: read('family'),
  cancel_scheduled_call: write('family', 'low'),

  // ── CS-1 customer surface (cs-registry only, never a head group) ───────────
  match_product_by_image: { domain: 'cs', mode: 'read', risk: 'low', routing: 'customer' },
  search_products: { domain: 'cs', mode: 'read', risk: 'low', routing: 'customer' },
  get_product_details: { domain: 'cs', mode: 'read', risk: 'low', routing: 'customer' },
  send_product_image: { domain: 'cs', mode: 'read', risk: 'low', routing: 'customer' },
  get_product_images: { domain: 'cs', mode: 'read', risk: 'low', routing: 'customer' },
  create_order_draft: { domain: 'cs', mode: 'write', risk: 'medium', routing: 'customer' },
  get_customer_order_status: { domain: 'cs', mode: 'read', risk: 'low', routing: 'customer' },
  handoff_to_human: { domain: 'cs', mode: 'write', risk: 'medium', routing: 'customer' },
}
