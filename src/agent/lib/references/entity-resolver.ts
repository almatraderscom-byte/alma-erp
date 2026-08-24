import { prisma } from '@/lib/prisma'
import { serverGet } from '@/lib/server-api'
import type { BusinessId } from '@/lib/businesses'
import { INTERNAL_ENTITY_REGISTRY, type InternalEntityNamespace } from './internal-registry'

type JsonObject = Record<string, unknown>

const DELEGATE_BY_NAMESPACE: Partial<Record<InternalEntityNamespace, string>> = {
  order: 'lifestyleOrder',
  trading_employee: 'tradingEmployeeProfile',
  agent_staff: 'agentStaff',
  staff_task: 'agentStaffTask',
  operational_task: 'operationalTask',
  open_task: 'agentOpenTask',
  owner_todo: 'agentTodo',
  approval_request: 'approvalRequest',
  agent_pending_action: 'agentPendingAction',
  product: 'lifestyleProduct',
  sku: 'lifestyleStockItem',
  variant: 'lifestyleStockItem',
  stock_item: 'lifestyleStockItem',
  customer: 'lifestyleCustomer',
  cs_customer: 'csCustomer',
  invoice: 'invoiceRecord',
  expense: 'lifestyleExpense',
  finance_entry: 'officeFundEntry',
  attendance_record: 'attendanceRecord',
  leave_request: 'attendanceLeave',
  payroll_run: 'payrollAccrualRun',
  trading_account: 'tradingAccount',
  trade: 'tradingTrade',
  settlement: 'tradingPartnershipSettlement',
  growth_recommendation: 'agentGrowthBrief',
  growth_event: 'agentMarketingEvent',
  ads_event: 'agentAdsEvent',
  creative_project: 'creativeProject',
  creative_asset: 'creativeProjectAsset',
  media_project: 'agentMediaProject',
  agent_project: 'agentProject',
  workflow_run: 'workflowRun',
  action_run: 'agentActionRun',
  artifact: 'agentArtifact',
  notification: 'notification',
  agent_notification: 'agentNotification',
  call: 'agentVoiceCall',
  scheduled_call: 'scheduledCall',
  reminder: 'agentReminder',
  bill: 'agentBill',
  appointment: 'agentAppointment',
  document: 'agentDocument',
  plan: 'agentPlan',
  finding: 'agentFinding',
}

const DISPLAY_KEYS = [
  'id', 'name', 'title', 'label', 'summary', 'description', 'detail', 'status',
  'type', 'role', 'priority', 'orderNumber', 'accountTitle', 'symbol', 'sku',
  'amount', 'currency', 'businessId', 'createdAt', 'updatedAt', 'dueAt',
  'completedAt', 'scheduledAt', 'startedAt', 'endedAt', 'startAt', 'endAt',
  'active', 'location', 'vendor', 'category',
] as const

function object(value: unknown): JsonObject | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
}

function displayValue(value: unknown): string | number | boolean | null | undefined {
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object' && value.constructor?.name === 'Decimal') {
    const decimal = String(value)
    if (/^-?\d+(?:\.\d+)?$/.test(decimal)) return decimal
  }
  return undefined
}

function projectRecord(row: JsonObject): JsonObject {
  const result: JsonObject = {}
  for (const key of DISPLAY_KEYS) {
    const value = displayValue(row[key])
    if (value !== undefined) result[key] = value
  }
  return result
}

function titleFor(namespace: InternalEntityNamespace, id: string, record: JsonObject): string {
  const spec = INTERNAL_ENTITY_REGISTRY[namespace]
  const value = record.name ?? record.title ?? record.label ?? record.summary ?? record.orderNumber ?? record.accountTitle
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 180) : `${spec.label} ${id}`
}

function rowBusinessId(row: JsonObject): BusinessId | null {
  const value = row.businessId
  return value === 'ALMA_LIFESTYLE' || value === 'CREATIVE_DIGITAL_IT' || value === 'ALMA_TRADING' ? value : null
}

async function resolveCdit(
  namespace: 'cdit_client' | 'cdit_project' | 'cdit_invoice',
  id: string,
): Promise<JsonObject | null> {
  if (namespace === 'cdit_client') {
    const raw = await serverGet<unknown>('cdit_client', { id }, 0)
    const envelope = object(raw)
    const row = object(envelope?.client) ?? object(object(envelope?.data)?.client)
      ?? object(envelope?.data) ?? envelope
    return row?.id === id ? { ...row, businessId: 'CREATIVE_DIGITAL_IT' } : null
  }
  const operation = namespace === 'cdit_project' ? 'cdit_projects' : 'cdit_invoices'
  const raw = await serverGet<unknown>(operation, { id }, 0)
  const envelope = object(raw)
  const nestedData = object(envelope?.data)
  const collectionKey = namespace === 'cdit_project' ? 'projects' : 'invoices'
  const candidates = Array.isArray(raw)
    ? raw
    : Array.isArray(envelope?.data)
      ? envelope!.data as unknown[]
      : Array.isArray(envelope?.rows)
        ? envelope!.rows as unknown[]
        : Array.isArray(envelope?.[collectionKey])
          ? envelope![collectionKey] as unknown[]
          : Array.isArray(nestedData?.[collectionKey])
            ? nestedData![collectionKey] as unknown[]
            : envelope ? [envelope] : []
  const found = candidates.map(object).find((row): row is JsonObject => row?.id === id) ?? null
  return found ? { ...found, businessId: 'CREATIVE_DIGITAL_IT' } : null
}

async function resolveGasEmployee(
  namespace: 'lifestyle_employee' | 'cdit_employee',
  id: string,
): Promise<JsonObject | null> {
  const businessId: BusinessId = namespace === 'cdit_employee'
    ? 'CREATIVE_DIGITAL_IT'
    : 'ALMA_LIFESTYLE'
  const raw = await serverGet<unknown>('hr_employees', { business_id: businessId }, 0)
  const envelope = object(raw)
  const candidates = Array.isArray(raw)
    ? raw
    : Array.isArray(envelope?.employees)
      ? envelope!.employees as unknown[]
      : Array.isArray(object(envelope?.data)?.employees)
        ? object(envelope?.data)!.employees as unknown[]
        : []
  const found = candidates.map(object).find((row) =>
    row?.emp_id === id || row?.employeeId === id || row?.id === id)
  if (!found) return null
  return {
    ...found,
    id,
    name: found.name,
    role: found.role,
    active: String(found.status ?? '').toLowerCase() !== 'inactive',
    businessId,
  }
}

async function resolveTradingEmployee(id: string): Promise<JsonObject | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const include = { user: { select: { name: true, email: true, active: true } } }
  let row = object(await db.tradingEmployeeProfile.findUnique({
    where: { id },
    include,
  }))
  if (row?.businessId !== 'ALMA_TRADING') row = null
  if (!row) {
    const candidates = await db.tradingEmployeeProfile.findMany({
      where: { businessId: 'ALMA_TRADING', employeeIdGas: id },
      take: 2,
      include,
    })
    // employeeIdGas is indexed but not schema-unique. Never guess when bad data
    // makes the business key ambiguous, and never accept a User.id as a profile id.
    if (!Array.isArray(candidates) || candidates.length !== 1) return null
    row = object(candidates[0])
  }
  if (!row) return null
  const user = object(row.user)
  return { ...row, id, name: user?.name, email: user?.email, active: user?.active, businessId: 'ALMA_TRADING' }
}

export type ResolvedReferenceEntity = {
  namespace: InternalEntityNamespace
  id: string
  title: string
  label: string
  status: 'active' | 'deleted'
  businessId: BusinessId | null
  fallbackPath: string
  fields: JsonObject
}

const FIXED_BUSINESS_WITHOUT_ROW_FIELD = new Set<InternalEntityNamespace>([
  'product', 'sku', 'variant', 'stock_item', 'cs_customer', 'growth_event', 'ads_event',
])

function authorizeResolvedRow(input: {
  namespace: InternalEntityNamespace
  businessId: BusinessId | null
  userId: string
}, row: JsonObject): { businessId: BusinessId | null } | null {
  const spec = INTERNAL_ENTITY_REGISTRY[input.namespace]
  if (spec.businessIds === 'personal') {
    // `/agent` personal tables are intentionally global to the authenticated
    // system owner. The route enforces the OWNER role before this lookup; they
    // are never relabelled into a business scope.
    return { businessId: null }
  }

  const actual = rowBusinessId(row)
  if (spec.businessIds === 'context') {
    if (!input.businessId || actual !== input.businessId) return null
  } else {
    if (!input.businessId || !spec.businessIds.includes(input.businessId)) return null
    if (actual && actual !== input.businessId) return null
    if (!actual && !FIXED_BUSINESS_WITHOUT_ROW_FIELD.has(input.namespace)) return null
  }

  if (input.namespace === 'notification') {
    // Role-target/broadcast authorization is not represented in resolver input;
    // only a notification explicitly owned by the authenticated user is exact.
    if (row.userId !== input.userId) return null
  }
  return { businessId: actual ?? input.businessId }
}

/** Read-only exact entity lookup used by web and native focus screens. */
export async function resolveReferenceEntity(input: {
  namespace: InternalEntityNamespace
  id: string
  businessId: BusinessId | null
  userId: string
}): Promise<ResolvedReferenceEntity | null> {
  const { namespace, id } = input
  if (!input.userId) return null
  let row: JsonObject | null = null
  if (namespace === 'cdit_client' || namespace === 'cdit_project' || namespace === 'cdit_invoice') {
    row = await resolveCdit(namespace, id)
  } else if (namespace === 'lifestyle_employee' || namespace === 'cdit_employee') {
    row = await resolveGasEmployee(namespace, id)
  } else if (namespace === 'trading_employee') {
    row = await resolveTradingEmployee(id)
  } else if (namespace === 'product') {
    // LifestyleProduct's primary key is `sku`, not `id`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const product = object(await (prisma as any).lifestyleProduct.findUnique({ where: { sku: id } }))
    row = product ? { ...product, id } : null
  } else if (namespace === 'creative_project') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    row = object(await (prisma as any).creativeProject.findFirst({ where: { id, ownerId: input.userId } }))
    if (row) row = { ...row, businessId: 'ALMA_LIFESTYLE' }
  } else if (namespace === 'creative_asset') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    row = object(await (prisma as any).creativeProjectAsset.findFirst({
      where: { id, project: { ownerId: input.userId } },
    }))
    if (row) row = { ...row, businessId: 'ALMA_LIFESTYLE' }
  } else {
    const delegateName = DELEGATE_BY_NAMESPACE[namespace]
    if (!delegateName) return null
    // Delegate names are closed over the reviewed map above; no request value is
    // used as a property lookup or query fragment.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const delegate = (prisma as any)[delegateName] as { findUnique(args: unknown): Promise<unknown> } | undefined
    if (!delegate?.findUnique) return null
    row = object(await delegate.findUnique({ where: { id } }))
  }
  if (!row) return null
  const authorization = authorizeResolvedRow(input, row)
  if (!authorization) return null
  const actualBusiness = authorization.businessId
  const fields = projectRecord(row)
  const deleted = row.deletedAt != null || row.archivedAt != null
    || row.isDeleted === true || row.isArchived === true
    || (namespace === 'bill' && row.active === false)
  return {
    namespace,
    id,
    title: titleFor(namespace, id, fields),
    label: INTERNAL_ENTITY_REGISTRY[namespace].label,
    status: deleted ? 'deleted' : 'active',
    businessId: actualBusiness,
    fallbackPath: INTERNAL_ENTITY_REGISTRY[namespace].fallbackSection,
    fields,
  }
}
