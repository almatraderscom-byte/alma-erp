import type { AgentTool } from './registry'
import { CORE_AGENT_TOOLS, TRADING_EXTENSION_TOOLS } from './registry'
import { STAFF_TOOLS } from './staff-tools'
import { SETTINGS_TOOLS } from './settings-tools'
import { ERP_TOOLS } from './erp-tools'
import { CONFIRM_TOOLS } from './confirm-tools'
import { FINANCE_TOOLS } from './finance-tools'
import { OWNER_CUSTOMER_INTEL_TOOLS } from './cs-tools'
import { CONTENT_ENGINE_TOOLS } from './content-engine-tools'
import { AD_CREATIVE_TOOLS } from './ad-creative-tools'
import { VIDEO_TOOLS } from './video-tools'
import { BRAND_TOOLS } from './brand-tools'
import { TRYON_TOOLS } from './tryon-tools'
import { ADS_TOOLS } from './ads-tools'
import { SEO_TOOLS } from './seo-tools'
import { COMPETITOR_TOOLS } from './competitor-tools'
import { RESEARCH_TOOLS } from './research-tools'
import { ADVISOR_TOOLS } from './advisor-tools'
import { MARKETING_TOOLS } from './marketing-tools'
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
import { COST_TOOLS } from './cost-tools'
import { LOCATION_TOOLS } from './location-tools'
import { PERSONAL_SAFE_TOOLS } from './registry'

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
  'trading',
  'personal',
] as const

export type ToolGroupName = typeof TOOL_GROUP_NAMES[number]

export const TOOL_GROUPS: Record<ToolGroupName, AgentTool[]> = {
  base: [
    ...CORE_AGENT_TOOLS,
    ...ASK_TOOLS,
    ...REMINDER_TOOLS,
    ...OWNER_TODO_TOOLS,
    ...PLAYBOOK_TOOLS,
    ...LEARNING_TOOLS,
    ...COST_TOOLS,
    ...SALAH_TOOLS,
  ],
  staff: [...STAFF_TOOLS, ...SETTINGS_TOOLS],
  erp: [...ERP_TOOLS, ...CONFIRM_TOOLS, ...LOCATION_TOOLS],
  finance: [...FINANCE_TOOLS],
  cs: [...OWNER_CUSTOMER_INTEL_TOOLS],
  content: [...CONTENT_ENGINE_TOOLS, ...AD_CREATIVE_TOOLS, ...VIDEO_TOOLS, ...BRAND_TOOLS, ...TRYON_TOOLS, ...REFERENCE_TOOLS],
  growth: [...ADS_TOOLS, ...MARKETING_TOOLS, ...SEO_TOOLS, ...COMPETITOR_TOOLS, ...RESEARCH_TOOLS, ...ADVISOR_TOOLS, ...REFERENCE_TOOLS],
  website: [...WEBSITE_TOOLS, ...CATALOG_TOOLS],
  salah: [...SALAH_TOOLS],
  diag: [...DIAGNOSTIC_TOOLS],
  trading: [...TRADING_EXTENSION_TOOLS],
  personal: [...PERSONAL_SAFE_TOOLS],
}
