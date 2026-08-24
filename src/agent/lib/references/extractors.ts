import type { AlmaRole } from '@/lib/roles'
import type { BusinessId } from '@/lib/businesses'
import { referenceCoverageForTool, type ReferenceExtractorId } from './coverage-manifest'
import {
  buildInternalEntityReference,
  buildInternalSectionReference,
  cleanReferenceLabel,
  deterministicReferenceId,
  normalizeReferenceEntityId,
  uniqueReferenceAliases,
  type InternalEntityNamespace,
} from './internal-registry'
import {
  buildExternalReference,
  buildOwnerFileMediaReference,
  buildVerifiedMetaObjectReference,
} from './external-url'
import { shouldCollectAgentReferences } from './flags'
import {
  AGENT_REFERENCE_VERSION,
  type AgentReferenceContext,
  type AgentReferenceV1,
  type ReferenceToolRecord,
} from './types'
import { filterAgentReferencesForContext, mergeAgentReferences } from './validator'

type JsonObject = Record<string, unknown>
const OWNER_ROLES: AlmaRole[] = ['SUPER_ADMIN']

function object(value: unknown): JsonObject | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
}

function rows(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(object).filter((row): row is JsonObject => row !== null) : []
}

function dataFromOutput(output: unknown): unknown {
  const envelope = object(output)
  return envelope && Object.prototype.hasOwnProperty.call(envelope, 'data') ? envelope.data : output
}

function rowLabel(row: JsonObject, fallback: string): string {
  return cleanReferenceLabel(
    row.label ?? row.name ?? row.title ?? row.summary ?? row.orderNumber ?? row.accountTitle,
    fallback,
  )
}

function addEntity(
  output: AgentReferenceV1[],
  namespace: InternalEntityNamespace,
  row: JsonObject,
  id: unknown,
  outputPath: string,
  toolName: string,
  context: AgentReferenceContext,
  aliases: readonly unknown[] = [],
): void {
  const safeId = normalizeReferenceEntityId(id)
  if (!safeId) return
  const reference = buildInternalEntityReference({
    namespace,
    id: safeId,
    label: rowLabel(row, `${namespace.replaceAll('_', ' ')} ${safeId}`),
    aliases: [row.orderNumber, row.accountTitle, row.email, ...aliases],
    rowBusinessId: row.businessId,
    sourceTool: toolName,
    outputPath,
    context,
  })
  if (reference) output.push(reference)
}

/**
 * The namespace decides which table the focus route reads, so it may only come
 * from a business the TOOL OUTPUT actually verified. `get_employee_overview`
 * reads the Lifestyle `hr_employees` table under `DEFAULT_AGENT_BUSINESS_ID`
 * and returns rows with no `businessId`; CDIT conversations are routed through
 * that same Lifestyle tool pool, so falling back to the conversation's business
 * minted `cdit_employee` for Lifestyle ids — a link that opens not-found, or an
 * unrelated CDIT employee if the ids collide (Codex P2, PR #845).
 *
 * `contextFallback` is therefore opt-in, for extractors whose output carries a
 * verified scope. Without one the reference stays Lifestyle, and a genuinely
 * cross-business row simply fails closed at the resolver.
 */
function employeeNamespace(
  business: unknown,
  context: AgentReferenceContext,
  options: { contextFallback?: boolean } = {},
): InternalEntityNamespace {
  const resolved = business ?? (options.contextFallback ? context.businessId : undefined)
  if (resolved === 'ALMA_TRADING') return 'trading_employee'
  if (resolved === 'CREATIVE_DIGITAL_IT') return 'cdit_employee'
  return 'lifestyle_employee'
}

function extractOrders(data: unknown, toolName: string, context: AgentReferenceContext): AgentReferenceV1[] {
  const root = object(data)
  if (!root) return []
  const out: AgentReferenceV1[] = []
  const addOrders = (value: unknown, path: string, erpOnly = false) => {
    rows(value).filter((row) => !erpOnly || row.source === 'erp').forEach((row, index) =>
      addEntity(out, 'order', row, row.id, `${path}[${index}].id`, toolName, context, [row.orderNumber]))
  }
  addOrders(root.orders, 'data.orders', toolName === 'get_customer_order_status')
  addOrders(root.orderEntities, 'data.orderEntities')
  const order = object(root.order)
  if (order) addEntity(out, 'order', order, order.id, 'data.order.id', toolName, context, [order.orderNumber])
  rows(root.issues).forEach((issue, issueIndex) =>
    rows(issue.orderEntities).forEach((row, rowIndex) =>
      addEntity(out, 'order', row, row.id, `data.issues[${issueIndex}].orderEntities[${rowIndex}].id`, toolName, context, [row.orderNumber])))
  rows(root.orderIssues).forEach((issue, issueIndex) =>
    rows(issue.orderEntities).forEach((row, rowIndex) =>
      addEntity(out, 'order', row, row.id, `data.orderIssues[${issueIndex}].orderEntities[${rowIndex}].id`, toolName, context, [row.orderNumber])))
  const business = object(root.business)
  if (business) rows(business.orderIssues).forEach((issue, issueIndex) =>
    rows(issue.orderEntities).forEach((row, rowIndex) =>
      addEntity(out, 'order', row, row.id, `data.business.orderIssues[${issueIndex}].orderEntities[${rowIndex}].id`, toolName, context, [row.orderNumber])))
  out.push(...extractPendingActions(data, toolName, context))
  return out
}

function extractEmployees(data: unknown, toolName: string, context: AgentReferenceContext): AgentReferenceV1[] {
  const root = object(data)
  if (!root) return []
  const candidates = Array.isArray(data) ? rows(data) : rows(root.employees)
  const out: AgentReferenceV1[] = []
  candidates.forEach((row, index) => addEntity(
    out,
    employeeNamespace(row.businessId, context),
    row,
    row.id ?? row.employeeId,
    `${Array.isArray(data) ? 'data' : 'data.employees'}[${index}].id`,
    toolName,
    context,
  ))
  return out
}

function extractAttendance(data: unknown, toolName: string, context: AgentReferenceContext): AgentReferenceV1[] {
  const root = object(data)
  if (!root) return []
  const out: AgentReferenceV1[] = []
  const business = root.businessId ?? context.businessId
  for (const key of ['employees', 'present', 'late', 'absent', 'penalties'] as const) {
    rows(root[key]).forEach((row, index) => addEntity(
      out,
      employeeNamespace(row.businessId ?? business, context, { contextFallback: true }),
      row,
      row.employeeId ?? row.id,
      `data.${key}[${index}].employeeId`,
      toolName,
      context,
    ))
  }
  return out
}

function extractTradingAccounts(data: unknown, toolName: string, context: AgentReferenceContext): AgentReferenceV1[] {
  const root = object(data)
  if (!root) return []
  const candidates = Array.isArray(data) ? rows(data) : rows(root.accounts)
  const account = object(root.account)
  if (account) candidates.push(account)
  const out: AgentReferenceV1[] = []
  candidates.forEach((row, index) => addEntity(out, 'trading_account', row, row.id, `data.accounts[${index}].id`, toolName, context, [row.accountTitle]))
  return out
}

function extractTrades(data: unknown, toolName: string, context: AgentReferenceContext): AgentReferenceV1[] {
  const root = object(data)
  if (!root) return []
  const out: AgentReferenceV1[] = []
  rows(root.trades).forEach((row, index) => {
    addEntity(out, 'trade', row, row.id, `data.trades[${index}].id`, toolName, context)
    const accountId = row.tradingAccountId ?? row.accountId
    if (accountId) addEntity(out, 'trading_account', row, accountId, `data.trades[${index}].tradingAccountId`, toolName, context, [row.accountTitle])
  })
  return out
}

function extractPendingActions(data: unknown, toolName: string, context: AgentReferenceContext): AgentReferenceV1[] {
  const root = object(data)
  if (!root) return []
  const out: AgentReferenceV1[] = []
  rows(root.pending).forEach((row, index) => addEntity(out, 'agent_pending_action', row, row.id, `data.pending[${index}].id`, toolName, context))
  const rootIds: Array<[unknown, string]> = [
    [root.pendingActionId, 'data.pendingActionId'],
    [root.gate1Id, 'data.gate1Id'],
    [root.batchPendingActionId, 'data.batchPendingActionId'],
    [root.approvedActionId, 'data.approvedActionId'],
    [root.existingActionId, 'data.existingActionId'],
  ]
  for (const [id, path] of rootIds) {
    if (id) addEntity(out, 'agent_pending_action', root, id, path, toolName, context)
  }
  if (Array.isArray(root.pendingActionIds)) root.pendingActionIds.forEach((id, index) =>
    addEntity(out, 'agent_pending_action', root, id, `data.pendingActionIds[${index}]`, toolName, context))
  rows(root.pendingPreview).forEach((row, index) =>
    addEntity(out, 'agent_pending_action', row, row.id, `data.pendingPreview[${index}].id`, toolName, context))
  if (toolName === 'dismiss_pending_approvals') rows(root.items).forEach((row, index) =>
    addEntity(out, 'agent_pending_action', row, row.id, `data.items[${index}].id`, toolName, context))
  rows(root.queued).forEach((row, index) => {
    if (row.pendingActionId) addEntity(out, 'agent_pending_action', row, row.pendingActionId,
      `data.queued[${index}].pendingActionId`, toolName, context)
  })
  rows(root.calls).forEach((row, index) => {
    if (row.pendingActionId) addEntity(out, 'agent_pending_action', row, row.pendingActionId,
      `data.calls[${index}].pendingActionId`, toolName, context)
  })
  rows(root.drafts).forEach((row, index) => {
    if (row.pendingActionId) addEntity(out, 'agent_pending_action', row, row.pendingActionId,
      `data.drafts[${index}].pendingActionId`, toolName, context)
  })
  const project = object(root.project)
  if (project?.pendingActionId) addEntity(out, 'agent_pending_action', project, project.pendingActionId,
    'data.project.pendingActionId', toolName, context)
  if (new Set([
    'request_agent_action',
    'check_browser_task',
    'check_workbench_task',
    'check_website_seo_audit',
  ]).has(toolName) && root.id) {
    addEntity(out, 'agent_pending_action', root, root.id, 'data.id', toolName, context)
  }
  return out
}

function extractStaff(data: unknown, toolName: string, context: AgentReferenceContext): AgentReferenceV1[] {
  const root = object(data)
  const candidates = Array.isArray(data) ? rows(data) : rows(root?.staff)
  const out: AgentReferenceV1[] = []
  candidates.forEach((row, index) => addEntity(out, 'agent_staff', row, row.id, `data.staff[${index}].id`, toolName, context))
  return out
}

function extractStaffTasks(data: unknown, toolName: string, context: AgentReferenceContext): AgentReferenceV1[] {
  const root = object(data)
  if (!root) return []
  const out: AgentReferenceV1[] = []
  rows(root.staffGroups).forEach((group, groupIndex) => {
    const staff = object(group.staff)
    if (staff) addEntity(out, 'agent_staff', staff, staff.id, `data.staffGroups[${groupIndex}].staff.id`, toolName, context)
    rows(group.tasks).forEach((row, taskIndex) => addEntity(out, 'staff_task', row, row.id, `data.staffGroups[${groupIndex}].tasks[${taskIndex}].id`, toolName, context))
  })
  const task = object(root.task)
  if (task) addEntity(out, 'staff_task', task, task.id, 'data.task.id', toolName, context)
  if (toolName === 'update_staff_task_status' && root.id) {
    addEntity(out, 'staff_task', root, root.id, 'data.id', toolName, context)
  }
  if (root.taskId) addEntity(out, 'staff_task', root, root.taskId, 'data.taskId', toolName, context)
  if (root.staffId) addEntity(out, 'agent_staff', root, root.staffId, 'data.staffId', toolName, context)
  for (const key of ['staffTasks', 'allTasks'] as const) rows(root[key]).forEach((row, index) =>
    addEntity(out, 'staff_task', row, row.id, `data.${key}[${index}].id`, toolName, context))
  for (const key of ['newTaskIds', 'taskIds'] as const) {
    if (Array.isArray(root[key])) root[key].forEach((id, index) =>
      addEntity(out, 'staff_task', root, id, `data.${key}[${index}]`, toolName, context))
  }
  const byStaff = object(root.byStaff)
  if (byStaff) for (const [staffId, value] of Object.entries(byStaff)) {
    rows(value).forEach((row, index) =>
      addEntity(out, 'staff_task', row, row.id, `data.byStaff.${staffId}[${index}].id`, toolName, context))
  }
  rows(root.explained).forEach((row, index) =>
    addEntity(out, 'staff_task', row, row.taskId, `data.explained[${index}].taskId`, toolName, context))
  if (toolName === 'get_marketing_history') rows(root.products).forEach((row, index) => {
    if (row.taskId) addEntity(out, 'staff_task', row, row.taskId, `data.products[${index}].taskId`, toolName, context)
  })
  out.push(...extractPendingActions(data, toolName, context))
  return out
}

function extractSimpleRows(
  data: unknown,
  toolName: string,
  context: AgentReferenceContext,
  namespace: InternalEntityNamespace,
  keys: readonly string[],
): AgentReferenceV1[] {
  const root = object(data)
  const out: AgentReferenceV1[] = []
  if (Array.isArray(data)) {
    rows(data).forEach((row, index) => addEntity(out, namespace, row, row.id, `data[${index}].id`, toolName, context))
    return out
  }
  if (!root) return out
  for (const key of keys) {
    rows(root[key]).forEach((row, index) => addEntity(out, namespace, row, row.id, `data.${key}[${index}].id`, toolName, context))
  }
  if (root.id) addEntity(out, namespace, root, root.id, 'data.id', toolName, context)
  return out
}

function extractOwnerTodos(data: unknown, toolName: string, context: AgentReferenceContext): AgentReferenceV1[] {
  const out = extractSimpleRows(data, toolName, context, 'owner_todo', [
    'todos', 'pending_items', 'in_progress_items',
  ])
  out.push(...extractPendingActions(data, toolName, context))
  return out
}

function extractReminders(data: unknown, toolName: string, context: AgentReferenceContext): AgentReferenceV1[] {
  const out = extractSimpleRows(data, toolName, context, 'reminder', ['reminders'])
  out.push(...extractPendingActions(data, toolName, context))
  return out
}

function extractOpenTasks(data: unknown, toolName: string, context: AgentReferenceContext): AgentReferenceV1[] {
  const root = object(data)
  if (!root) return []
  const out: AgentReferenceV1[] = []
  const id = root.openTaskId ?? root.checkpointId ?? root.id
  if (id) addEntity(out, 'open_task', root, id,
    root.checkpointId ? 'data.checkpointId' : 'data.openTaskId', toolName, context)
  return out
}

function extractProducts(data: unknown, toolName: string, context: AgentReferenceContext): AgentReferenceV1[] {
  const root = object(data)
  if (!root) return []
  const out: AgentReferenceV1[] = []
  const product = object(root.product)
  if (product) addEntity(out, 'product', product, product.sku ?? product.code, 'data.product.sku', toolName, context, [product.sku, product.code])
  rows(root.products).forEach((row, index) => {
    if (row.source === 'image-catalog') return
    const id = row.sku ?? row.code
    addEntity(out, 'product', row, id, `data.products[${index}].${row.sku ? 'sku' : 'code'}`, toolName, context, [row.sku, row.code])
  })
  if (toolName === 'get_product_details' && root.code) {
    addEntity(out, 'product', root, root.code, 'data.code', toolName, context, [root.code])
  }
  if (toolName === 'get_product_details') rows(root.members).forEach((row, index) =>
    addEntity(out, 'product', row, row.code, `data.members[${index}].code`, toolName, context, [row.code]))
  return out
}

function extractCustomers(data: unknown, toolName: string, context: AgentReferenceContext): AgentReferenceV1[] {
  const root = object(data)
  if (!root) return []
  const out: AgentReferenceV1[] = []
  const namespace: InternalEntityNamespace = toolName === 'get_customer_intelligence' || toolName === 'get_customer_segments'
    ? 'cs_customer'
    : 'customer'
  const customer = object(root.customer)
  if (customer) addEntity(out, namespace, customer, customer.id, 'data.customer.id', toolName, context, [customer.phone, customer.email])
  rows(root.customers).forEach((row, index) => addEntity(out, namespace, row, row.id, `data.customers[${index}].id`, toolName, context, [row.phone, row.email]))
  if (toolName === 'get_customer_segments') for (const key of ['winBack', 'loyal', 'atRisk', 'newRecent'] as const) {
    rows(root[key]).forEach((row, index) =>
      addEntity(out, 'cs_customer', row, row.id, `data.${key}[${index}].id`, toolName, context, [row.phone, row.email]))
  }
  return out
}

function extractMediaProject(data: unknown, toolName: string, context: AgentReferenceContext): AgentReferenceV1[] {
  const root = object(data)
  if (!root) return []
  const project = object(root.project)
  const out: AgentReferenceV1[] = []
  if (project) addEntity(out, 'media_project', project, project.id, 'data.project.id', toolName, context)
  if (root.projectId) addEntity(out, 'media_project', root, root.projectId, 'data.projectId', toolName, context)
  out.push(...extractPendingActions(data, toolName, context))
  return out
}

function extractCreativeAssets(data: unknown, toolName: string, context: AgentReferenceContext): AgentReferenceV1[] {
  const root = object(data)
  if (!root) return []
  const out: AgentReferenceV1[] = []
  rows(root.gallery).forEach((row, index) => {
    addEntity(out, 'agent_pending_action', row, row.id, `data.gallery[${index}].id`, toolName, context)
  })
  return out
}

function artifactReference(data: unknown, toolName: string, context: AgentReferenceContext): AgentReferenceV1[] {
  const root = object(data)
  if (!root) return []
  const nested = object(root.artifactCard) ?? object(root.artifact)
  const artifact = nested ?? (root.artifactId ? root : null)
  const artifactId = normalizeReferenceEntityId(nested?.id ?? root.artifactId)
  const out = extractPendingActions(data, toolName, context)
  if (!artifact || !artifactId) return out
  const label = rowLabel(artifact, `Artifact ${artifactId}`)
  const observedAt = context.observedAt && !Number.isNaN(Date.parse(context.observedAt)) ? new Date(context.observedAt).toISOString() : new Date().toISOString()
  out.push({
    version: AGENT_REFERENCE_VERSION,
    refId: deterministicReferenceId(['artifact', artifactId]),
    kind: 'artifact_report',
    label,
    destination: {
      type: 'artifact_report',
      artifactId,
      apiPath: `/api/assistant/artifacts/${encodeURIComponent(artifactId)}/doc`,
      mimeType: typeof artifact.type === 'string' ? artifact.type : undefined,
      fileName: label,
    },
    entity: { namespace: 'artifact', type: 'agent_artifact', id: artifactId },
    purpose: 'report',
    audience: { businessId: null, businessScope: 'personal', roles: [...(context.roles ?? OWNER_ROLES)] },
    provenance: {
      source: 'tool_output', verifiedBy: 'explicit_extractor', sourceTool: toolName,
      outputPath: nested === object(root.artifactCard) ? 'data.artifactCard.id'
        : nested ? 'data.artifact.id' : 'data.artifactId',
    },
    observedAt,
    openMode: 'artifact_viewer',
    aliases: uniqueReferenceAliases([label, artifactId]),
  })
  return out
}

function extractWebResearch(data: unknown, toolName: string, context: AgentReferenceContext): AgentReferenceV1[] {
  const root = object(data)
  if (!root) return []
  const out: AgentReferenceV1[] = []
  rows(root.results).forEach((row, index) => {
    const ref = buildExternalReference({ rawUrl: row.url ?? row.link, label: row.title, kind: 'external_source', purpose: 'evidence', source: 'tool_output', sourceTool: toolName, outputPath: `data.results[${index}].url`, context })
    if (ref) out.push(ref)
  })
  for (const [key, source] of [['finalUrl', 'browser_observed'], ['resolvedUrl', 'connector_output'], ['url', 'tool_output']] as const) {
    if (!root[key]) continue
    const ref = buildExternalReference({ rawUrl: root[key], label: root.title, kind: 'external_source', purpose: 'evidence', source, sourceTool: toolName, outputPath: `data.${key}`, context })
    if (ref) out.push(ref)
  }
  return out
}

function extractLiveBrowser(data: unknown, toolName: string, context: AgentReferenceContext): AgentReferenceV1[] {
  const root = object(data)
  if (!root) return []
  const page = object(root.page)
  const candidates: Array<[unknown, string]> = [
    [root.currentUrl, 'data.currentUrl'],
    [root.finalUrl, 'data.finalUrl'],
    [page?.url, 'data.page.url'],
  ]
  const out: AgentReferenceV1[] = []
  for (const [url, outputPath] of candidates) {
    const ref = buildExternalReference({ rawUrl: url, label: root.title ?? page?.title, source: 'browser_observed', sourceTool: toolName, outputPath, context })
    if (ref) out.push(ref)
  }
  return out
}

function extractMetaObjects(data: unknown, toolName: string, context: AgentReferenceContext): AgentReferenceV1[] {
  const root = object(data)
  if (!root) return []
  const out: AgentReferenceV1[] = []
  const accountId = root.adAccountId ?? root.accountId
  const specs: Array<{ level: 'campaign' | 'ad_set' | 'ad' | 'creative' | 'commerce_order'; keys: string[] }> = [
    { level: 'campaign', keys: ['campaign', 'campaigns'] },
    { level: 'ad_set', keys: ['adSet', 'adSets'] },
    { level: 'ad', keys: ['ad', 'ads'] },
    { level: 'creative', keys: ['creative', 'creatives'] },
    { level: 'commerce_order', keys: ['commerceOrder', 'commerceOrders'] },
  ]
  for (const spec of specs) {
    for (const key of spec.keys) {
      const one = object(root[key])
      const candidates = one ? [one] : rows(root[key])
      candidates.forEach((row, index) => {
        const ref = buildVerifiedMetaObjectReference({
          rawUrl: row.url ?? row.permalinkUrl ?? row.link,
          label: row.name ?? row.title,
          adAccountId: row.adAccountId ?? row.accountId ?? accountId,
          level: spec.level,
          objectId: row.id ?? row.objectId,
          sourceTool: toolName,
          outputPath: `data.${key}${one ? '' : `[${index}]`}`,
          context,
        })
        if (ref) out.push(ref)
      })
    }
  }
  out.push(...extractPendingActions(data, toolName, context))
  return out
}

function extractCalls(data: unknown, toolName: string, context: AgentReferenceContext): AgentReferenceV1[] {
  const root = object(data)
  const out: AgentReferenceV1[] = []
  if (Array.isArray(data)) {
    rows(data).forEach((row, index) => addEntity(out, 'scheduled_call', row, row.id, `data[${index}].id`, toolName, context))
    return out
  }
  if (!root) return out
  rows(root.recent).forEach((row, index) => addEntity(out, 'call', row, row.id, `data.recent[${index}].id`, toolName, context))
  rows(root.upcoming).forEach((row, index) => addEntity(out, 'scheduled_call', row, row.id, `data.upcoming[${index}].id`, toolName, context))
  if (root.callRecordId) addEntity(out, 'call', root, root.callRecordId, 'data.callRecordId', toolName, context)
  if (root.id) addEntity(out, 'scheduled_call', root, root.id, 'data.id', toolName, context)
  out.push(...extractPendingActions(data, toolName, context))
  return out
}

function extractGrowth(data: unknown, toolName: string, context: AgentReferenceContext): AgentReferenceV1[] {
  const root = object(data)
  if (!root) return []
  const out: AgentReferenceV1[] = []
  if (toolName === 'growth_brief_get') {
    rows(root.history).forEach((row, index) =>
      addEntity(out, 'growth_recommendation', row, row.id, `data.history[${index}].id`, toolName, context))
    const brief = object(root.brief)
    if (brief) addEntity(out, 'growth_recommendation', brief, brief.id, 'data.brief.id', toolName, context)
  }
  if (toolName === 'growth_brief_draft' || toolName === 'growth_brief_approve') {
    addEntity(out, 'growth_recommendation', root, root.id, 'data.id', toolName, context)
  }
  if (toolName === 'get_ad_recommendations') rows(root.events).forEach((row, index) =>
    addEntity(out, 'ads_event', row, row.id, `data.events[${index}].id`, toolName, context))
  if (toolName === 'resolve_ad_recommendation') {
    const event = object(root.event)
    if (event) addEntity(out, 'ads_event', event, event.id, 'data.event.id', toolName, context)
  }
  return out
}

function extractPlans(data: unknown, toolName: string, context: AgentReferenceContext): AgentReferenceV1[] {
  const root = object(data)
  if (!root) return []
  const out: AgentReferenceV1[] = []
  const addPlan = (row: JsonObject, id: unknown, path: string) =>
    addEntity(out, 'plan', row, id, path, toolName, context)
  if (root.plan_id) addPlan(root, root.plan_id, 'data.plan_id')
  if (root.planId) addPlan(root, root.planId, 'data.planId')
  const plan = object(root.plan)
  if (plan) addPlan(plan, plan.id, 'data.plan.id')
  rows(root.created).forEach((row, index) => addPlan(row, row.planId, `data.created[${index}].planId`))
  return out
}

function extractWorkflowRuns(data: unknown, toolName: string, context: AgentReferenceContext): AgentReferenceV1[] {
  const root = object(data)
  if (!root) return []
  const out: AgentReferenceV1[] = []
  const run = object(root.run)
  if (run) addEntity(out, 'workflow_run', run, run.id, 'data.run.id', toolName, context)
  rows(root.runs).forEach((row, index) =>
    addEntity(out, 'workflow_run', row, row.id, `data.runs[${index}].id`, toolName, context))
  if (root.runId) addEntity(out, 'workflow_run', root, root.runId, 'data.runId', toolName, context)
  return out
}

function extractTradingExtended(data: unknown, toolName: string, context: AgentReferenceContext): AgentReferenceV1[] {
  const root = object(data)
  if (!root) return []
  const out: AgentReferenceV1[] = []
  const scan = (envelope: JsonObject, prefix: string) => {
    for (const key of ['accounts', 'accountPerformance', 'targets'] as const) {
      rows(envelope[key]).forEach((row, index) => addEntity(
        out, 'trading_account', row, row.accountId ?? row.id,
        `${prefix}.${key}[${index}].${row.accountId ? 'accountId' : 'id'}`, toolName, context,
        [row.accountTitle]))
    }
    const account = object(envelope.account)
    if (account) addEntity(out, 'trading_account', account, account.id, `${prefix}.account.id`, toolName, context, [account.accountTitle])
    rows(envelope.recentTrades).forEach((row, index) => {
      addEntity(out, 'trade', row, row.id, `${prefix}.recentTrades[${index}].id`, toolName, context)
      if (row.accountId ?? row.tradingAccountId) addEntity(
        out, 'trading_account', row, row.accountId ?? row.tradingAccountId,
        `${prefix}.recentTrades[${index}].accountId`, toolName, context)
    })
    rows(envelope.rows).forEach((row, index) => {
      if (row.accountId) addEntity(out, 'trading_account', row, row.accountId,
        `${prefix}.rows[${index}].accountId`, toolName, context, [row.accountTitle])
      if (Array.isArray(row.accountIds)) row.accountIds.forEach((id, accountIndex) =>
        addEntity(out, 'trading_account', row, id,
          `${prefix}.rows[${index}].accountIds[${accountIndex}]`, toolName, context))
    })
  }
  scan(root, 'data')
  for (const key of ['dashboard', 'volumeTargets', 'merchantProgress', 'dailyReports'] as const) {
    const nested = object(root[key])
    if (nested) scan(nested, `data.${key}`)
  }
  return out
}

function extractStaffExtended(data: unknown, toolName: string, context: AgentReferenceContext): AgentReferenceV1[] {
  const root = object(data)
  if (!root) return []
  const out: AgentReferenceV1[] = []
  const addStaffRows = (value: unknown, path: string) => rows(value).forEach((row, index) => {
    if (row.staffId) addEntity(out, 'agent_staff', row, row.staffId, `${path}[${index}].staffId`, toolName, context)
  })
  for (const key of ['tasks', 'perStaff', 'staffMessages', 'agingFollowUps', 'correctionContext', 'trends', 'standings'] as const) {
    addStaffRows(root[key], `data.${key}`)
  }
  const handover = object(root.handover)
  if (handover) addStaffRows(handover.perStaff, 'data.handover.perStaff')
  const card = object(root.card)
  if (card) addStaffRows(card.perStaff, 'data.card.perStaff')
  out.push(...extractPendingActions(data, toolName, context))
  return out
}

function extractDelegation(data: unknown, toolName: string, context: AgentReferenceContext): AgentReferenceV1[] {
  const root = object(data)
  const out = filterAgentReferencesForContext(Array.isArray(root?.references) ? root.references : [], context)
  out.push(...extractPendingActions(data, toolName, context))
  return out
}

/**
 * Camera and Mac screenshots are returned for INLINE display — the tools hand
 * back a bare `data.imageUrl` and the prompt tells the head to write
 * `![alt](imageUrl)`. Under an active contract an image with no verified media
 * reference is replaced by its alt text, so the owner asked for a screenshot
 * and got a caption (Codex P1, PR #845). Mint the reference from the tool's own
 * verified output; the URL still goes through the external-URL security gate,
 * and the client still asks before contacting the remote host.
 */
function extractToolScreenshot(
  data: unknown,
  toolName: string,
  context: AgentReferenceContext,
): AgentReferenceV1[] {
  const out: AgentReferenceV1[] = []
  const root = object(data)
  const rawUrl = typeof root?.imageUrl === 'string' ? root.imageUrl : null
  if (rawUrl) {
    const path = (() => {
      try {
        const u = new URL(rawUrl)
        // The files endpoint names the object in `?path=`, not in its own path.
        return (u.searchParams.get('path') ?? u.pathname).toLowerCase()
      } catch { return '' }
    })()
    const mediaType = path.endsWith('.jpg') || path.endsWith('.jpeg')
      ? 'image/jpeg'
      : path.endsWith('.webp') ? 'image/webp' : 'image/png'
    const label = typeof root?.camera === 'string' && root.camera
      ? root.camera
      : typeof root?.device === 'string' && root.device ? root.device : 'Screenshot'
    // Mac screenshots are served from ALMA's own authenticated files endpoint
    // (`/api/assistant/files?path=…&redirect=1`); the generic external validator
    // refuses `redirect` query keys, which is right for third-party hosts and
    // wrong for ours. Try the reviewed internal builder first, then the external
    // one for genuinely remote storage URLs (camera snapshots).
    const ref = buildOwnerFileMediaReference({
      rawUrl, label, mediaType, source: 'tool_output',
      sourceTool: toolName, outputPath: 'data.imageUrl', context,
    }) ?? buildExternalReference({
      rawUrl,
      label,
      kind: 'external_media',
      purpose: 'media',
      mediaType,
      source: 'tool_output',
      sourceTool: toolName,
      outputPath: 'data.imageUrl',
      context,
    })
    if (ref) out.push(ref)
  }
  // mac_desk_control's amber-policy branch still returns a durable pending action.
  out.push(...extractPendingActions(data, toolName, context))
  return out
}

function runExtractor(
  extractorId: ReferenceExtractorId,
  data: unknown,
  toolName: string,
  context: AgentReferenceContext,
): AgentReferenceV1[] {
  switch (extractorId) {
    case 'orders': return extractOrders(data, toolName, context)
    case 'employees': return extractEmployees(data, toolName, context)
    case 'attendance': return extractAttendance(data, toolName, context)
    case 'trading_accounts': return extractTradingAccounts(data, toolName, context)
    case 'trading_trades': return extractTrades(data, toolName, context)
    case 'pending_actions': return extractPendingActions(data, toolName, context)
    case 'tool_screenshot': return extractToolScreenshot(data, toolName, context)
    case 'staff': return extractStaff(data, toolName, context)
    case 'staff_tasks': return extractStaffTasks(data, toolName, context)
    case 'owner_todos': return extractOwnerTodos(data, toolName, context)
    case 'open_tasks': return extractOpenTasks(data, toolName, context)
    case 'products': return extractProducts(data, toolName, context)
    case 'customers': return extractCustomers(data, toolName, context)
    case 'media_project': return extractMediaProject(data, toolName, context)
    case 'creative_assets': return extractCreativeAssets(data, toolName, context)
    case 'artifact': return artifactReference(data, toolName, context)
    case 'web_research': return extractWebResearch(data, toolName, context)
    case 'live_browser': return extractLiveBrowser(data, toolName, context)
    case 'meta_objects': return extractMetaObjects(data, toolName, context)
    case 'calls': return extractCalls(data, toolName, context)
    case 'agent_projects': return Array.isArray(data)
      ? extractSimpleRows({ projects: data }, toolName, context, 'agent_project', ['projects'])
      : extractSimpleRows(data, toolName, context, 'agent_project', ['projects'])
    case 'appointments': return extractSimpleRows(data, toolName, context, 'appointment', ['appointments'])
    case 'bills': return extractSimpleRows(data, toolName, context, 'bill', ['bills'])
    case 'reminders': return extractReminders(data, toolName, context)
    case 'documents': return extractSimpleRows(data, toolName, context, 'document', ['documents'])
    case 'scheduled_calls': return extractCalls(data, toolName, context)
    case 'plans': return extractPlans(data, toolName, context)
    case 'workflow_runs': return extractWorkflowRuns(data, toolName, context)
    case 'growth': return extractGrowth(data, toolName, context)
    case 'trading_extended': return extractTradingExtended(data, toolName, context)
    case 'staff_extended': return extractStaffExtended(data, toolName, context)
    case 'delegation': return extractDelegation(data, toolName, context)
  }
}

/** Extract only reviewed, named output paths; fall back to a static registry section. */
export function extractAgentReferences(
  toolName: string,
  output: unknown,
  context: AgentReferenceContext = {},
): AgentReferenceV1[] {
  if (!shouldCollectAgentReferences()) return []
  const coverage = referenceCoverageForTool(toolName)
  if (!coverage) return []
  const data = dataFromOutput(output)
  if (coverage.classification === 'none') return []
  if (coverage.classification === 'section') {
    const section = coverage.fallbackSection
      ? buildInternalSectionReference(coverage.fallbackSection, context, { sourceTool: toolName, outputPath: 'data' })
      : null
    return section ? [section] : []
  }
  const exact = runExtractor(coverage.extractorId!, data, toolName, context)
  const canonical = filterAgentReferencesForContext(exact, context)
  if (canonical.length > 0 || !coverage.fallbackSection) return canonical
  const fallback = buildInternalSectionReference(coverage.fallbackSection, context, { sourceTool: toolName, outputPath: 'data' })
  return fallback ? [fallback] : []
}

export function extractAgentReferencesFromRecords(
  records: ReadonlyArray<ReferenceToolRecord>,
  context: AgentReferenceContext = {},
): AgentReferenceV1[] {
  if (!shouldCollectAgentReferences()) return []
  return mergeAgentReferences(...records
    .filter((record) => record.status == null || record.status === 'success')
    .map((record) => {
      const recordContext = { ...context, observedAt: record.observedAt ?? context.observedAt }
      const envelope = object(record.output)
      const explicit = Array.isArray(envelope?.references)
        ? filterAgentReferencesForContext(envelope.references, recordContext)
        : []
      return mergeAgentReferences(
        explicit,
        extractAgentReferences(record.toolName, record.output, recordContext),
      )
    }))
}

/** Common owner executor seam; handler-authored references are revalidated. */
export function enrichToolResultWithReferences<
  T extends { success: boolean; data?: unknown; references?: AgentReferenceV1[] },
>(
  toolName: string,
  result: T,
  context: AgentReferenceContext = {},
): T & { references?: AgentReferenceV1[] } {
  if (!result.success || !shouldCollectAgentReferences()) return { ...result, references: undefined }
  const references = filterAgentReferencesForContext([
    ...(result.references ?? []),
    ...extractAgentReferences(toolName, { data: result.data }, context),
  ], context)
  return { ...result, references: references.length ? references : undefined }
}

export function referenceContextFromServerContext(serverContext: Record<string, unknown>): AgentReferenceContext {
  const rawBusiness = serverContext.businessId
  const businessId: BusinessId | undefined = rawBusiness === 'ALMA_LIFESTYLE'
    || rawBusiness === 'CREATIVE_DIGITAL_IT'
    || rawBusiness === 'ALMA_TRADING'
    ? rawBusiness
    : undefined
  const role = serverContext.role ?? object(serverContext.session)?.role ?? object(object(serverContext.session)?.user)?.role
  const roles: AlmaRole[] | undefined = role === 'SUPER_ADMIN' || role === 'ADMIN' || role === 'HR' || role === 'STAFF' || role === 'VIEWER'
    ? [role]
    : undefined
  return { businessId, roles, observedAt: new Date().toISOString() }
}
