import type { AgentTool } from './registry'
import { CORE_AGENT_TOOLS, TRADING_EXTENSION_TOOLS } from './registry'
import { STAFF_TOOLS, get_marketing_history } from './staff-tools'
import { SETTINGS_TOOLS } from './settings-tools'
import { ERP_TOOLS } from './erp-tools'
import { CONFIRM_TOOLS } from './confirm-tools'
import { FINANCE_TOOLS } from './finance-tools'
import { OWNER_CUSTOMER_INTEL_TOOLS } from './cs-tools'
import { CS_AUTONOMY_TOOLS } from './cs-autonomy-tools'
import { ORDER_AUTONOMY_TOOLS } from './order-autonomy-tools'
import { FINANCE_AUTONOMY_TOOLS } from './finance-autonomy-tools'
import { CONTENT_ENGINE_TOOLS } from './content-engine-tools'
import { AD_CREATIVE_TOOLS } from './ad-creative-tools'
import { VIDEO_TOOLS } from './video-tools'
import { BRAND_TOOLS } from './brand-tools'
import { TRYON_TOOLS } from './tryon-tools'
import { STUDIO_TOOLS } from './studio-tools'
import { ADS_TOOLS } from './ads-tools'
import { SEO_TOOLS } from './seo-tools'
import { ANALYTICS_TOOLS } from './analytics-tools'
import { CAMPAIGN_TOOLS } from './campaign-tools'
import { GBP_TOOLS } from './gbp-tools'
import { GROWTH_TOOLS } from './growth-tools'
import { COMPETITOR_TOOLS } from './competitor-tools'
import { RESEARCH_TOOLS } from './research-tools'
import { ADVISOR_TOOLS } from './advisor-tools'
import { MARKETING_TOOLS } from './marketing-tools'
import { META_ADS_TOOLS } from './meta-ads-tools'
import { WEBSITE_TOOLS } from './website-tools'
import { CATALOG_TOOLS } from './catalog-tools'
import { SALAH_TOOLS } from './salah-tools'
import { DIAGNOSTIC_TOOLS } from './diagnostic-tools'
import { REMINDER_TOOLS } from './reminder-tools'
import { ASK_TOOLS } from './ask-tools'
import { OWNER_TODO_TOOLS } from './owner-todo-tools'
import { PLAYBOOK_TOOLS } from './playbook-tools'
import { LEARNING_TOOLS } from './learning-tools'
import { REFERENCE_TOOLS } from './reference-tools'
import { QC_TOOLS } from './qc-tools'
import { COST_TOOLS } from './cost-tools'
import { LOCATION_TOOLS } from './location-tools'
import { CAMERA_TOOLS } from './camera-tools'
import { WORK_TODO_TOOLS } from './work-todo-tools'
import { ORCHESTRATOR_TOOLS } from './orchestrator-tools'
import { AUTONOMY_TOOLS } from './autonomy-tools'
import { HEARTBEAT_TOOLS } from './heartbeat-tools'
import { VISION_TOOLS } from './vision-tools'
import { SIMULATE_TOOLS } from './simulate-tools'
import { PERSONAL_SAFE_TOOLS } from './registry'
import { place_agent_call } from './personal-tools'
import { WA_TOOLS } from './wa-tools'
import { BILLS_TOOLS } from './bills-tools'
import { IMPORTANT_DATE_TOOLS } from './important-dates-tools'
import { PERSONAL_BRIEFING_TOOLS } from './personal-briefing-tools'
import { APPOINTMENT_TOOLS } from './appointment-tools'
import { HEALTH_TOOLS } from './health-tools'
import { DOCUMENT_TOOLS } from './document-tools'

export const TOOL_GROUP_NAMES = [
  'base',
  'staff',
  'erp',
  'finance',
  'cs',
  'content',
  'growth',
  'website',
  'salah',
  'diag',
  'vision',
  'trading',
  'personal',
  'cost',
] as const

export type ToolGroupName = typeof TOOL_GROUP_NAMES[number]

export const TOOL_GROUPS: Record<ToolGroupName, AgentTool[]> = {
  base: [
    ...CORE_AGENT_TOOLS,
    ...ASK_TOOLS,
    ...REMINDER_TOOLS,
    // Two-way live call sibling of outbound_phone_call (one-way, in REMINDER_TOOLS).
    // Both must travel together so the owner-business head can pick the right one;
    // without this the head only ever saw the one-way tool and (correctly) said it
    // had "no two-way call tool" when asked to talk + listen.
    place_agent_call,
    // Business WhatsApp send (Twilio). Dormant + kill-switched until the owner sets
    // the Twilio WhatsApp creds; visible to the head so "WhatsApp-এ পাঠাও/টেস্ট" works.
    ...WA_TOOLS,
    ...OWNER_TODO_TOOLS,
    ...WORK_TODO_TOOLS,
    ...PLAYBOOK_TOOLS,
    ...LEARNING_TOOLS,
    ...SALAH_TOOLS,
    ...ORCHESTRATOR_TOOLS,
    // Autonomy control panel: check_autonomy / set_autonomy_policy / undo_action.
    // Always-on so the owner can inspect or tune the agent's autonomy (and undo a
    // self-done action) from any chat without a keyword unlocking the group.
    ...AUTONOMY_TOOLS,
    // Autonomous "idle heartbeat" control: heartbeat_control (status/enable/disable/
    // test_now). Always-on so the owner can inspect or steer the self-waking head
    // from any chat without a keyword unlocking the group.
    ...HEARTBEAT_TOOLS,
    // Personal-life autonomy (Tier 1): bills/subscriptions, important dates, and the
    // one-shot personal morning briefing. Always-on so the owner can manage personal
    // life from any chat without a keyword unlocking the group.
    ...BILLS_TOOLS,
    ...IMPORTANT_DATE_TOOLS,
    ...PERSONAL_BRIEFING_TOOLS,
    // Personal-life autonomy (Tier 2): calendar/appointments (salah-deconflict),
    // health & medication tracking, and the OCR document/receipt vault. Always-on
    // alongside Tier 1 so personal life is manageable from any chat.
    ...APPOINTMENT_TOOLS,
    ...HEALTH_TOOLS,
    ...DOCUMENT_TOOLS,
    // Live office-camera snapshot (owner only). Always-on + tiny (one tool) so the
    // owner can ask to see the office/staff from any chat without a keyword unlocking
    // a group — reliability matters more than the few tokens it adds to the cache.
    ...CAMERA_TOOLS,
  ],
  staff: [...STAFF_TOOLS, ...SETTINGS_TOOLS],
  erp: [...ERP_TOOLS, ...CONFIRM_TOOLS, ...LOCATION_TOOLS, ...ORDER_AUTONOMY_TOOLS],
  finance: [...FINANCE_TOOLS, ...SIMULATE_TOOLS, ...FINANCE_AUTONOMY_TOOLS],
  cs: [...OWNER_CUSTOMER_INTEL_TOOLS, ...CS_AUTONOMY_TOOLS],
  // STUDIO_TOOLS (run_creative_studio / check_studio_job) ride in `content`:
  // they were executable-but-ungrouped (Phase 2 audit) — the head saw the Studio
  // described in prompts but had no route to the tools outside the fixed set.
  content: [...CONTENT_ENGINE_TOOLS, ...AD_CREATIVE_TOOLS, ...VIDEO_TOOLS, ...BRAND_TOOLS, ...TRYON_TOOLS, ...REFERENCE_TOOLS, ...QC_TOOLS, ...STUDIO_TOOLS],
  // get_marketing_history also rides in `growth` (it lives in staff-tools): the
  // marketing head carries growth but NOT staff, and needs the "last promoted"
  // read for post planning — without this it was expected-but-unavailable there.
  growth: [...ADS_TOOLS, ...MARKETING_TOOLS, ...META_ADS_TOOLS, ...SEO_TOOLS, ...ANALYTICS_TOOLS, ...CAMPAIGN_TOOLS, ...GBP_TOOLS, ...GROWTH_TOOLS, ...COMPETITOR_TOOLS, ...RESEARCH_TOOLS, ...ADVISOR_TOOLS, ...REFERENCE_TOOLS, ...SIMULATE_TOOLS, get_marketing_history],
  website: [...WEBSITE_TOOLS, ...CATALOG_TOOLS],
  salah: [...SALAH_TOOLS],
  diag: [...DIAGNOSTIC_TOOLS],
  vision: [...VISION_TOOLS],
  trading: [...TRADING_EXTENSION_TOOLS],
  personal: [...PERSONAL_SAFE_TOOLS],
  // Lazy group: API-credit / subscription bookkeeping. Owner-initiated only and
  // keyword-distinctive, so it's gated out of the always-on base group to shave
  // ~520 tok off the cold cache-write on every other turn.
  cost: [...COST_TOOLS],
}
