import {
  ENTITY_ROUTE_BUSINESS_QUERY,
  type BusinessId,
} from '@/lib/businesses'
import type { AlmaRole } from '@/lib/roles'
import {
  AGENT_REFERENCE_VERSION,
  DEFAULT_REFERENCE_ROLES,
  type AgentReferenceContext,
  type AgentReferenceEntityV1,
  type AgentReferenceV1,
} from './types'

const OWNER: AlmaRole[] = ['SUPER_ADMIN']
const ADMINS: AlmaRole[] = ['SUPER_ADMIN', 'ADMIN']
const HR: AlmaRole[] = ['SUPER_ADMIN', 'HR']
const ALL: AlmaRole[] = [...DEFAULT_REFERENCE_ROLES]

export interface InternalSectionSpec {
  id: string
  label: string
  webPath: string
  nativePath: string
  openMode: 'internal_native' | 'protected_web'
  businessIds: readonly BusinessId[] | 'any'
  roles: readonly AlmaRole[]
}

function section(
  id: string,
  label: string,
  webPath: string,
  businessIds: readonly BusinessId[] | 'any' = 'any',
  roles: readonly AlmaRole[] = ALL,
  nativePath = webPath,
  openMode: InternalSectionSpec['openMode'] = 'internal_native',
): InternalSectionSpec {
  return { id, label, webPath, nativePath, openMode, businessIds, roles }
}

function protectedWebSection(
  id: string,
  label: string,
  webPath: string,
  businessIds: readonly BusinessId[] | 'any' = 'any',
  roles: readonly AlmaRole[] = ALL,
): InternalSectionSpec {
  return section(id, label, webPath, businessIds, roles, webPath, 'protected_web')
}

/**
 * Server-owned static destination registry. This is the only place a section
 * route may be minted for an AgentReferenceV1.
 */
export const INTERNAL_SECTION_REGISTRY = {
  dashboard: section('dashboard', 'Dashboard', '/'),
  briefing: section('briefing', 'Briefing', '/briefing', 'any', ADMINS),
  insights: section('insights', 'Insights', '/insights', 'any', ADMINS),
  activity: section('activity', 'Activity', '/activity', 'any', ADMINS),
  analytics: section('analytics', 'Analytics', '/analytics'),
  approvals: section('approvals', 'Approvals', '/approvals'),
  audit: section('audit', 'Audit', '/audit', 'any', OWNER),
  crm: section('crm', 'CRM', '/crm', ['ALMA_LIFESTYLE'], ADMINS),
  inventory: section('inventory', 'Inventory', '/inventory', ['ALMA_LIFESTYLE'], ADMINS),
  supplier_import: section('supplier_import', 'Supplier import', '/inventory/supplier-import', ['ALMA_LIFESTYLE'], ADMINS),
  orders: section('orders', 'Orders', '/orders', ['ALMA_LIFESTYLE']),
  invoices: section('invoices', 'Invoices', '/invoice', ['ALMA_LIFESTYLE', 'CREATIVE_DIGITAL_IT']),
  finance: section('finance', 'Finance', '/finance', 'any', [...ADMINS, 'HR']),
  office_fund: section('office_fund', 'Office fund', '/finance/office-fund', 'any', [...ADMINS, 'HR']),
  personal_ledger: section('personal_ledger', 'Personal ledger', '/finance/personal-ledger', 'any', OWNER),
  expenses: section('expenses', 'Expense Manager', '/expenses', 'any', [...ADMINS, 'HR']),
  employees: section('employees', 'Employees', '/employees', 'any', [...OWNER, 'HR']),
  attendance: section('attendance', 'Attendance', '/attendance', 'any', ALL),
  payroll: section('payroll', 'Payroll', '/payroll', 'any', HR),
  portal: section('portal', 'My desk', '/portal'),
  portal_expense: section('portal_expense', 'My expenses', '/portal/expense'),
  portal_office: section('portal_office', 'Office', '/portal/office'),
  portal_payment_accounts: section('portal_payment_accounts', 'Payment accounts', '/portal/payment-accounts'),
  portal_wallet: section('portal_wallet', 'Wallet', '/portal/wallet'),
  digital_home: section('digital_home', 'Digital dashboard', '/digital', ['CREATIVE_DIGITAL_IT'], ADMINS),
  digital_clients: section('digital_clients', 'Digital clients', '/digital/clients', ['CREATIVE_DIGITAL_IT'], ADMINS),
  digital_projects: section('digital_projects', 'Digital projects', '/digital/projects', ['CREATIVE_DIGITAL_IT'], ADMINS),
  digital_invoices: section('digital_invoices', 'Digital invoices', '/digital/invoices', ['CREATIVE_DIGITAL_IT'], ADMINS),
  digital_finance: section('digital_finance', 'Digital finance', '/digital/finance', ['CREATIVE_DIGITAL_IT'], ADMINS),
  trading_home: section('trading_home', 'Trading', '/trading', ['ALMA_TRADING']),
  trading_accounts: section('trading_accounts', 'Trading accounts', '/trading/accounts', ['ALMA_TRADING']),
  trading_target_control: section('trading_target_control', 'Trading target control', '/trading/target-control', ['ALMA_TRADING'], ADMINS),
  trading_telegram: section('trading_telegram', 'Trading Telegram', '/trading/telegram', ['ALMA_TRADING']),
  trading_hr: section('trading_hr', 'Trading HR', '/trading/hr', ['ALMA_TRADING'], [...OWNER, 'HR']),
  trading_analytics: section('trading_analytics', 'Trading analytics', '/trading/analytics', ['ALMA_TRADING'], ADMINS),
  task_spotlight: section('task_spotlight', 'Task Spotlight', '/operations/task-spotlight', 'any', OWNER),
  business_archive: section('business_archive', 'Business archive', '/operations/business-archive', 'any', OWNER),
  system_diagnostics: section('system_diagnostics', 'System diagnostics', '/operations/system-diagnostics', 'any', OWNER),
  agent_home: section('agent_home', 'ALMA Agent', '/agent', 'any', OWNER),
  agent_hub: section('agent_hub', 'Agent Hub', '/agent', 'any', OWNER, '/agent/hub'),
  agent_growth: section('agent_growth', 'Agent Growth', '/agent/growth', ['ALMA_LIFESTYLE'], OWNER),
  agent_ads: section('agent_ads', 'Ads center', '/agent/growth', ['ALMA_LIFESTYLE'], OWNER),
  creative_studio: section('creative_studio', 'Creative Studio', '/agent/creative-studio', ['ALMA_LIFESTYLE'], ADMINS),
  catalog_images: section('catalog_images', 'Catalog images', '/agent/catalog-images', ['ALMA_LIFESTYLE'], ADMINS),
  agent_media: protectedWebSection('agent_media', 'Media studio', '/agent/media', 'any', OWNER),
  agent_staff_monitor: section('agent_staff_monitor', 'Staff monitor', '/agent/staff-monitor', 'any', OWNER),
  agent_trading_staff: section('agent_trading_staff', 'Trading staff', '/agent/trading-staff', ['ALMA_TRADING'], OWNER),
  agent_live_watch: section('agent_live_watch', 'Live Watch', '/agent/live-watch', 'any', OWNER),
  agent_browser_live: section('agent_browser_live', 'Live browser', '/agent/browser-live', 'any', OWNER),
  agent_whatsapp: section('agent_whatsapp', 'WhatsApp', '/agent/whatsapp', 'any', OWNER),
  agent_mac: protectedWebSection('agent_mac', 'Mac remote control', '/agent/mac', 'any', OWNER),
  agent_phone: protectedWebSection('agent_phone', 'Phone', '/agent/phone', 'any', OWNER),
  phone_console: protectedWebSection('phone_console', 'Phone console', '/agent/phone-console', 'any', OWNER),
  phone_calls: protectedWebSection('phone_calls', 'Phone calls', '/agent/phone-console/calls', 'any', OWNER),
  phone_live: protectedWebSection('phone_live', 'Live phone console', '/agent/phone-console/live', 'any', OWNER),
  phone_recordings: protectedWebSection('phone_recordings', 'Call recordings', '/agent/phone-console/recordings', 'any', OWNER),
  phone_quality: protectedWebSection('phone_quality', 'Call quality', '/agent/phone-console/quality', 'any', OWNER),
  phone_routing: protectedWebSection('phone_routing', 'Phone routing', '/agent/phone-console/routing', 'any', OWNER),
  agent_costs: section('agent_costs', 'Agent costs', '/agent/costs', 'any', OWNER),
  agent_subscriptions: section('agent_subscriptions', 'Agent subscriptions', '/agent/costs', 'any', OWNER, '/agent/subscriptions'),
  known_people: section('known_people', 'Known people', '/agent/known-people', 'any', OWNER),
  settings_session: section('settings_session', 'Session settings', '/settings/session'),
  settings_database: section('settings_database', 'Database settings', '/settings/database', 'any', [...OWNER, 'ADMIN', 'HR']),
  settings_notifications: section('settings_notifications', 'Notification settings', '/settings/notifications'),
  settings_sms: section('settings_sms', 'SMS settings', '/settings/sms', 'any', ADMINS),
  settings_telegram: section('settings_telegram', 'Telegram Ops settings', '/settings/telegram-ops', 'any', OWNER),
  settings_users: section('settings_users', 'User settings', '/settings/users', 'any', ADMINS),
  settings_branding: section('settings_branding', 'Brand settings', '/settings/branding', 'any', OWNER),
} as const satisfies Record<string, InternalSectionSpec>

export type InternalSectionId = keyof typeof INTERNAL_SECTION_REGISTRY

export interface InternalEntitySpec {
  namespace: string
  type: string
  label: string
  fallbackSection: InternalSectionId
  businessIds: readonly BusinessId[] | 'context' | 'personal'
  roles: readonly AlmaRole[]
  /** Existing exact UI route when one is proven; otherwise the generic focus viewer. */
  exactPath?: (id: string, businessId: BusinessId | null) => string
}

const exact = (root: string) => (id: string, businessId: BusinessId | null) => {
  const query = businessId ? `?${ENTITY_ROUTE_BUSINESS_QUERY}=${encodeURIComponent(businessId)}` : ''
  return `${root}/${encodeURIComponent(id)}${query}`
}

function entity(
  namespace: string,
  type: string,
  label: string,
  fallbackSection: InternalSectionId,
  businessIds: InternalEntitySpec['businessIds'],
  roles: readonly AlmaRole[] = OWNER,
  exactPath?: InternalEntitySpec['exactPath'],
): InternalEntitySpec {
  return { namespace, type, label, fallbackSection, businessIds, roles, exactPath }
}

/** Namespace registry intentionally keeps similarly named systems distinct. */
export const INTERNAL_ENTITY_REGISTRY = {
  order: entity('order', 'lifestyle_order', 'Order', 'orders', ['ALMA_LIFESTYLE'], ALL, exact('/orders')),
  lifestyle_employee: entity('lifestyle_employee', 'employee', 'Lifestyle employee', 'employees', ['ALMA_LIFESTYLE'], [...OWNER, 'HR'], exact('/employees')),
  cdit_employee: entity('cdit_employee', 'employee', 'CDIT employee', 'employees', ['CREATIVE_DIGITAL_IT'], [...OWNER, 'HR']),
  trading_employee: entity('trading_employee', 'employee', 'Trading employee', 'trading_hr', ['ALMA_TRADING'], [...OWNER, 'HR']),
  agent_staff: entity('agent_staff', 'agent_staff', 'Agent staff', 'agent_staff_monitor', 'context'),
  staff_task: entity('staff_task', 'agent_staff_task', 'Staff task', 'agent_staff_monitor', 'context'),
  operational_task: entity('operational_task', 'operational_task', 'Operational task', 'task_spotlight', 'context'),
  open_task: entity('open_task', 'agent_open_task', 'Open task', 'agent_home', 'context'),
  owner_todo: entity('owner_todo', 'agent_todo', 'Owner todo', 'agent_home', ['ALMA_LIFESTYLE']),
  approval_request: entity('approval_request', 'approval_request', 'Approval request', 'approvals', 'context'),
  agent_pending_action: entity('agent_pending_action', 'agent_pending_action', 'Pending action', 'approvals', 'context'),
  product: entity('product', 'lifestyle_product', 'Product', 'inventory', ['ALMA_LIFESTYLE'], ADMINS),
  sku: entity('sku', 'lifestyle_stock_item', 'SKU', 'inventory', ['ALMA_LIFESTYLE'], ADMINS),
  variant: entity('variant', 'lifestyle_stock_item', 'Product variant', 'inventory', ['ALMA_LIFESTYLE'], ADMINS),
  stock_item: entity('stock_item', 'lifestyle_stock_item', 'Stock item', 'inventory', ['ALMA_LIFESTYLE'], ADMINS),
  customer: entity('customer', 'lifestyle_customer', 'Customer', 'crm', ['ALMA_LIFESTYLE'], ADMINS),
  cs_customer: entity('cs_customer', 'messaging_customer', 'Messaging customer', 'crm', ['ALMA_LIFESTYLE'], ADMINS),
  cdit_client: entity('cdit_client', 'cdit_client', 'Digital client', 'digital_clients', ['CREATIVE_DIGITAL_IT'], ADMINS, exact('/digital/clients')),
  cdit_project: entity('cdit_project', 'cdit_project', 'Digital project', 'digital_projects', ['CREATIVE_DIGITAL_IT'], ADMINS),
  invoice: entity('invoice', 'invoice_record', 'Invoice', 'invoices', 'context', ADMINS),
  cdit_invoice: entity('cdit_invoice', 'cdit_invoice', 'Digital invoice', 'digital_invoices', ['CREATIVE_DIGITAL_IT'], ADMINS),
  expense: entity('expense', 'lifestyle_expense', 'Expense', 'expenses', 'context', [...ADMINS, 'HR']),
  finance_entry: entity('finance_entry', 'office_fund_entry', 'Finance entry', 'finance', 'context', [...ADMINS, 'HR']),
  attendance_record: entity('attendance_record', 'attendance_record', 'Attendance record', 'attendance', 'context'),
  leave_request: entity('leave_request', 'attendance_leave', 'Leave request', 'attendance', 'context'),
  payroll_run: entity('payroll_run', 'payroll_accrual_run', 'Payroll run', 'payroll', 'context', HR),
  trading_account: entity('trading_account', 'trading_account', 'Trading account', 'trading_accounts', ['ALMA_TRADING'], ALL, exact('/trading/accounts')),
  trade: entity('trade', 'trading_trade', 'Trade', 'trading_accounts', ['ALMA_TRADING']),
  settlement: entity('settlement', 'trading_partnership_settlement', 'Settlement', 'trading_accounts', ['ALMA_TRADING']),
  growth_recommendation: entity('growth_recommendation', 'agent_growth_brief', 'Growth recommendation', 'agent_growth', ['ALMA_LIFESTYLE']),
  growth_event: entity('growth_event', 'agent_marketing_event', 'Growth event', 'agent_growth', ['ALMA_LIFESTYLE']),
  ads_event: entity('ads_event', 'agent_ads_event', 'Ads event', 'agent_ads', ['ALMA_LIFESTYLE']),
  creative_project: entity('creative_project', 'creative_project', 'Creative project', 'creative_studio', ['ALMA_LIFESTYLE']),
  creative_asset: entity('creative_asset', 'creative_project_asset', 'Creative asset', 'creative_studio', ['ALMA_LIFESTYLE']),
  media_project: entity('media_project', 'agent_media_project', 'Media project', 'agent_media', 'personal'),
  agent_project: entity('agent_project', 'agent_project', 'Agent project', 'agent_home', 'personal'),
  workflow_run: entity('workflow_run', 'workflow_run', 'Workflow run', 'agent_home', 'context'),
  action_run: entity('action_run', 'agent_action_run', 'Action run', 'agent_home', 'context'),
  artifact: entity('artifact', 'agent_artifact', 'Artifact', 'agent_home', 'personal'),
  notification: entity('notification', 'notification', 'Notification', 'activity', 'context'),
  agent_notification: entity('agent_notification', 'agent_notification', 'Agent notification', 'agent_home', 'personal'),
  call: entity('call', 'agent_voice_call', 'Call', 'phone_calls', 'personal'),
  scheduled_call: entity('scheduled_call', 'scheduled_call', 'Scheduled call', 'phone_calls', 'personal'),
  reminder: entity('reminder', 'agent_reminder', 'Reminder', 'agent_home', 'personal'),
  bill: entity('bill', 'agent_bill', 'Bill', 'agent_home', 'personal'),
  appointment: entity('appointment', 'agent_appointment', 'Appointment', 'agent_home', 'personal'),
  document: entity('document', 'agent_document', 'Document', 'agent_home', 'personal'),
  plan: entity('plan', 'agent_plan', 'Plan', 'agent_home', 'context'),
  finding: entity('finding', 'agent_finding', 'Finding', 'agent_home', 'personal'),
} as const satisfies Record<string, InternalEntitySpec>

export type InternalEntityNamespace = keyof typeof INTERNAL_ENTITY_REGISTRY

export const EXTERNAL_OBJECT_NAMESPACES = {
  alma_order: 'alma_order',
  meta_commerce_order: 'meta_commerce_order',
  meta_campaign: 'meta_campaign',
  meta_ad_set: 'meta_ad_set',
  meta_ad: 'meta_ad',
  meta_creative: 'meta_creative',
  youtube_video: 'youtube_video',
  youtube_channel: 'youtube_channel',
  youtube_playlist: 'youtube_playlist',
} as const

const SAFE_REFERENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

export function normalizeReferenceEntityId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const id = value.trim()
  return SAFE_REFERENCE_ID.test(id) ? id : null
}

export function cleanReferenceLabel(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const label = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
  return label || fallback
}

export function uniqueReferenceAliases(values: readonly unknown[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string') continue
    const alias = cleanReferenceLabel(value, '')
    const key = alias.toLocaleLowerCase('en')
    if (alias.length < 2 || seen.has(key)) continue
    seen.add(key)
    out.push(alias)
  }
  return out.slice(0, 12)
}

/** Stable non-cryptographic identity; its input contains no secrets. */
export function deterministicReferenceId(parts: readonly string[]): string {
  const value = parts.join('\u001f')
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `ref_v1_${(hash >>> 0).toString(36)}`
}

function observedAt(context: AgentReferenceContext): string {
  const raw = context.observedAt
  if (raw && !Number.isNaN(Date.parse(raw))) return new Date(raw).toISOString()
  return new Date().toISOString()
}

export function buildInternalSectionReference(
  sectionId: InternalSectionId,
  context: AgentReferenceContext = {},
  overrides: { label?: string; sourceTool?: string; outputPath?: string } = {},
): AgentReferenceV1 | null {
  const spec = INTERNAL_SECTION_REGISTRY[sectionId]
  const businessId = context.businessId ?? null
  if (spec.businessIds !== 'any' && businessId && !spec.businessIds.includes(businessId)) return null
  const roles = context.roles?.filter((role) => spec.roles.includes(role)) ?? [...spec.roles]
  if (context.roles && roles.length === 0) return null
  const label = cleanReferenceLabel(overrides.label, spec.label)
  return {
    version: AGENT_REFERENCE_VERSION,
    refId: deterministicReferenceId(['section', sectionId, businessId ?? 'cross']),
    kind: 'internal_section',
    label,
    destination: {
      type: 'internal_section',
      sectionId,
      webPath: spec.webPath,
      nativePath: spec.nativePath,
    },
    purpose: 'navigate',
    audience: {
      businessId,
      businessScope: businessId ? 'exact' : 'cross_business',
      roles,
    },
    provenance: {
      source: overrides.sourceTool ? 'tool_output' : 'server_registry',
      verifiedBy: 'server_registry',
      sourceTool: overrides.sourceTool,
      outputPath: overrides.outputPath,
    },
    observedAt: observedAt(context),
    openMode: spec.openMode,
    aliases: uniqueReferenceAliases([label, spec.label]),
  }
}

export function resolveEntityBusinessId(
  spec: InternalEntitySpec,
  context: AgentReferenceContext,
  rowBusinessId?: unknown,
): BusinessId | null {
  const row = rowBusinessId === 'ALMA_LIFESTYLE'
    || rowBusinessId === 'CREATIVE_DIGITAL_IT'
    || rowBusinessId === 'ALMA_TRADING'
    ? rowBusinessId
    : null
  if (spec.businessIds === 'personal') return null
  if (spec.businessIds === 'context') return row ?? context.businessId ?? null
  if (row && spec.businessIds.includes(row)) return row
  if (context.businessId && spec.businessIds.includes(context.businessId)) return context.businessId
  return spec.businessIds.length === 1 ? spec.businessIds[0] : null
}

export function buildInternalEntityReference(input: {
  namespace: InternalEntityNamespace
  id: unknown
  label?: unknown
  aliases?: readonly unknown[]
  rowBusinessId?: unknown
  sourceTool: string
  outputPath: string
  context?: AgentReferenceContext
}): AgentReferenceV1 | null {
  const spec = INTERNAL_ENTITY_REGISTRY[input.namespace]
  const id = normalizeReferenceEntityId(input.id)
  if (!id) return null
  const context = input.context ?? {}
  const businessId = resolveEntityBusinessId(spec, context, input.rowBusinessId)
  if (spec.businessIds !== 'personal' && !businessId) return null
  if (context.businessId && businessId && context.businessId !== businessId) return null
  const roles = context.roles?.filter((role) => spec.roles.includes(role)) ?? [...spec.roles]
  if (context.roles && roles.length === 0) return null
  const label = cleanReferenceLabel(input.label, `${spec.label} ${id}`)
  const entityValue: AgentReferenceEntityV1 = { namespace: spec.namespace, type: spec.type, id }
  const genericPath = `/agent/references/${encodeURIComponent(spec.namespace)}/${encodeURIComponent(id)}`
  const businessQuery = businessId
    ? `?${ENTITY_ROUTE_BUSINESS_QUERY}=${encodeURIComponent(businessId)}`
    : ''
  const genericFocusPath = `${genericPath}${businessQuery}`
  const webFocusPath = spec.exactPath?.(id, businessId) ?? genericFocusPath
  const apiPath = `/api/assistant/references/${encodeURIComponent(spec.namespace)}/${encodeURIComponent(id)}${businessQuery}`
  return {
    version: AGENT_REFERENCE_VERSION,
    refId: deterministicReferenceId(['entity', spec.namespace, id, businessId ?? 'personal']),
    kind: 'internal_entity',
    label,
    destination: {
      type: 'internal_entity',
      namespace: spec.namespace,
      id,
      webPath: webFocusPath,
      // Native list screens cannot represent deleted/forbidden/not-found
      // exact states. The provider-neutral focus screen can, so every entity
      // reference uses it while web keeps a proven normal detail route.
      nativePath: genericFocusPath,
      apiPath,
    },
    entity: entityValue,
    purpose: 'navigate',
    audience: {
      businessId,
      businessScope: businessId ? 'exact' : 'personal',
      roles,
    },
    provenance: {
      source: 'tool_output',
      verifiedBy: 'explicit_extractor',
      sourceTool: input.sourceTool,
      outputPath: input.outputPath,
    },
    observedAt: observedAt(context),
    openMode: 'internal_native',
    aliases: uniqueReferenceAliases([label, ...(input.aliases ?? []), id]),
  }
}

export function sectionForEntity(namespace: InternalEntityNamespace): InternalSectionId {
  return INTERNAL_ENTITY_REGISTRY[namespace].fallbackSection
}
