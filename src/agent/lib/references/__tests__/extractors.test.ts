import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  extractAgentReferences,
  extractAgentReferencesFromRecords,
} from '../extractors'
import { buildInternalEntityReference } from '../internal-registry'

const originalRollout = process.env.AGENT_REFERENCES_ROLLOUT
const originalKill = process.env.AGENT_REFERENCES_KILL_SWITCH

const lifestyle = { businessId: 'ALMA_LIFESTYLE' as const, roles: ['SUPER_ADMIN' as const] }
const trading = { businessId: 'ALMA_TRADING' as const, roles: ['SUPER_ADMIN' as const] }

describe('named tool-output extractors', () => {
  beforeEach(() => {
    process.env.AGENT_REFERENCES_ROLLOUT = 'on'
    delete process.env.AGENT_REFERENCES_KILL_SWITCH
  })
  afterEach(() => {
    if (originalRollout == null) delete process.env.AGENT_REFERENCES_ROLLOUT
    else process.env.AGENT_REFERENCES_ROLLOUT = originalRollout
    if (originalKill == null) delete process.env.AGENT_REFERENCES_KILL_SWITCH
    else process.env.AGENT_REFERENCES_KILL_SWITCH = originalKill
  })

  it.each([
    ['get_orders', { orders: [{ id: 'ord_1', orderNumber: 'AL-1' }] }, lifestyle, 'order'],
    ['get_employee_overview', { employees: [{ id: 'emp_1', name: 'A' }] }, lifestyle, 'lifestyle_employee'],
    ['get_attendance', { present: [{ employeeId: 'emp_1', name: 'A' }] }, lifestyle, 'lifestyle_employee'],
    ['get_trading_accounts', { accounts: [{ id: 'acct_1', accountTitle: 'Main' }] }, trading, 'trading_account'],
    ['get_trading_trades_today', { trades: [{ id: 'trade_1', tradingAccountId: 'acct_1' }] }, trading, 'trade'],
    ['get_pending_approvals', { pending: [{ id: 'pending_1' }] }, lifestyle, 'agent_pending_action'],
    ['get_all_staff', { staff: [{ id: 'staff_1', name: 'Ops' }] }, lifestyle, 'agent_staff'],
    ['get_staff_tasks', { staffGroups: [{ staff: { id: 'staff_1' }, tasks: [{ id: 'task_1' }] }] }, lifestyle, 'agent_staff'],
    ['add_owner_todo', { id: 'todo_1', title: 'Call' }, lifestyle, 'owner_todo'],
    ['track_open_task', { openTaskId: 'open_1', title: 'Follow up' }, lifestyle, 'open_task'],
    ['search_products', { products: [{ id: 'prod_1', sku: 'SKU-1' }] }, lifestyle, 'product'],
    ['get_customer_summary', { customers: [{ id: 'cust_1', name: 'Buyer' }] }, lifestyle, 'customer'],
    ['get_media_project', { project: { id: 'media_1', title: 'Launch' } }, lifestyle, 'media_project'],
    ['list_creative_studio_assets', { gallery: [{ id: 'pending_creative_1' }] }, lifestyle, 'agent_pending_action'],
    ['list_agent_projects', [{ id: 'project_1', name: 'ERP' }], lifestyle, 'agent_project'],
    ['list_appointments', { appointments: [{ id: 'appt_1', title: 'Doctor' }] }, lifestyle, 'appointment'],
    ['list_bills', { bills: [{ id: 'bill_1', name: 'Internet' }] }, lifestyle, 'bill'],
    ['list_reminders', [{ id: 'rem_1', title: 'Pay' }], lifestyle, 'reminder'],
    ['search_documents', { documents: [{ id: 'doc_1', title: 'Receipt' }] }, lifestyle, 'document'],
    ['list_scheduled_calls', [{ id: 'sched_1', who: 'Supplier' }], lifestyle, 'scheduled_call'],
  ] as const)('%s extracts only the reviewed exact namespace', (tool, data, context, namespace) => {
    const refs = extractAgentReferences(tool, { data }, context)
    expect(refs.some((ref) => ref.kind === 'internal_entity' && ref.entity?.namespace === namespace)).toBe(true)
  })

  it('extracts artifacts, external research, browser observations, and call families', () => {
    expect(extractAgentReferences('save_artifact', {
      data: { artifactId: 'artifact_1', title: 'Report' },
    }, lifestyle)[0]).toMatchObject({ kind: 'artifact_report', entity: { id: 'artifact_1' } })

    const research = extractAgentReferences('web_research', {
      data: {
        results: [{ title: 'Article', url: 'https://example.com/article' }],
        finalUrl: 'https://example.com/final',
      },
    }, lifestyle)
    expect(research.map((ref) => ref.kind)).toEqual(['external_source', 'external_source'])

    expect(extractAgentReferences('live_browser_look', {
      data: { currentUrl: 'https://example.com/observed' },
    }, lifestyle)[0]).toMatchObject({
      kind: 'external_source',
      provenance: { source: 'browser_observed' },
    })

    const calls = extractAgentReferences('get_call_history', {
      data: { recent: [{ id: 'call_1' }], upcoming: [{ id: 'scheduled_1' }] },
    }, lifestyle)
    expect(calls.map((ref) => ref.entity?.namespace).sort()).toEqual(['call', 'scheduled_call'])
  })

  it('extracts a Meta object only with account, level, object id, and matching canonical URL', () => {
    const url = 'https://www.facebook.com/adsmanager/manage/campaigns?act=123&selected_campaign_ids=456'
    const valid = extractAgentReferences('meta_ads_get_ad_entities', {
      data: { adAccountId: 'act_123', campaigns: [{ id: '456', name: 'Eid', url }] },
    }, lifestyle)
    expect(valid[0]).toMatchObject({
      kind: 'external_object',
      entity: { namespace: 'meta_campaign', accountId: 'act_123', id: '456', level: 'campaign' },
    })

    const mismatch = extractAgentReferences('meta_ads_get_ad_entities', {
      data: { adAccountId: 'act_999', campaigns: [{ id: '456', url }] },
    }, lifestyle)
    expect(mismatch).toHaveLength(1)
    expect(mismatch[0]).toMatchObject({ kind: 'internal_section' })
  })

  it('never persists a temporary signed document URL', () => {
    const refs = extractAgentReferences('get_document', {
      data: {
        id: 'doc_1',
        title: 'Receipt',
        downloadUrl: 'https://storage.example.com/doc?token=SECRET&signature=ABC',
      },
    }, lifestyle)
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ kind: 'internal_entity', entity: { namespace: 'document', id: 'doc_1' } })
  })

  it('extracts the SEO artifact card and otherwise uses its honest section fallback', () => {
    const exact = extractAgentReferences('check_website_seo_audit', {
      data: { artifactCard: { id: 'seo_1', title: 'SEO report', type: 'markdown' } },
    }, lifestyle)
    expect(exact[0]).toMatchObject({ kind: 'artifact_report', entity: { id: 'seo_1' } })

    const queued = extractAgentReferences('check_website_seo_audit', {
      data: { id: 'pending_seo_1', status: 'running' },
    }, lifestyle)
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({
      kind: 'internal_entity',
      entity: { namespace: 'agent_pending_action', id: 'pending_seo_1' },
      provenance: { outputPath: 'data.id' },
    })

    const completed = extractAgentReferences('check_website_seo_audit', {
      data: {
        id: 'pending_seo_1',
        status: 'executed',
        artifactCard: { id: 'seo_1', title: 'SEO report', type: 'markdown' },
      },
    }, lifestyle)
    expect(completed.map((ref) => `${ref.entity?.namespace}:${ref.entity?.id}`).sort()).toEqual([
      'agent_pending_action:pending_seo_1',
      'artifact:seo_1',
    ])

    const fallback = extractAgentReferences('check_website_seo_audit', { data: { status: 'running' } }, lifestyle)
    expect(fallback[0]).toMatchObject({
      kind: 'internal_section',
      destination: { type: 'internal_section', sectionId: 'agent_growth' },
    })
  })

  it('does not persist expiring Creative Studio URLs or invent creative-project identities', () => {
    const refs = extractAgentReferences('list_creative_studio_assets', {
      data: {
        gallery: [{
          id: 'pending_creative_1',
          imageUrl: 'https://storage.example.com/file?token=SECRET&signature=ABC',
          thumbUrl: 'https://storage.example.com/thumb?token=SECRET&signature=ABC',
        }],
        models: [{ id: 'brand_model_1', imageUrl: 'https://storage.example.com/model?token=SECRET' }],
        products: [{ productCode: 'SKU-1', imageUrl: 'https://storage.example.com/product?token=SECRET' }],
      },
    }, lifestyle)
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({
      kind: 'internal_entity',
      entity: { namespace: 'agent_pending_action', id: 'pending_creative_1' },
    })
  })

  it('extracts only proven composite entity paths', () => {
    const pending = extractAgentReferences('recommend_ad_actions', {
      data: { batchPendingActionId: 'pending_batch_1' },
    }, lifestyle)
    expect(pending[0]).toMatchObject({ entity: { namespace: 'agent_pending_action', id: 'pending_batch_1' } })

    const staff = extractAgentReferences('merge_into_proposal', {
      data: {
        pendingActionId: 'pending_staff_1',
        staffTasks: [{ id: 'staff_task_1' }],
        allTasks: [{ id: 'staff_task_2' }],
        newTaskIds: ['staff_task_3'],
      },
    }, lifestyle)
    expect(staff.map((ref) => `${ref.entity?.namespace}:${ref.entity?.id}`).sort()).toEqual([
      'agent_pending_action:pending_staff_1',
      'staff_task:staff_task_1',
      'staff_task:staff_task_2',
      'staff_task:staff_task_3',
    ])

    expect(extractAgentReferences('update_staff_task_status', {
      data: { id: 'staff_task_4', status: 'done' },
    }, lifestyle)[0]).toMatchObject({ entity: { namespace: 'staff_task', id: 'staff_task_4' } })

    const todos = extractAgentReferences('manage_work_todos', {
      data: { pending_items: [{ id: 'todo_1' }], in_progress_items: [{ id: 'todo_2' }] },
    }, lifestyle)
    expect(todos.map((ref) => ref.entity?.id).sort()).toEqual(['todo_1', 'todo_2'])

    const briefing = extractAgentReferences('generate_owner_briefing', {
      data: { orderIssues: [{ orderEntities: [{ id: 'order_1', orderNumber: 'AL-1' }] }] },
    }, lifestyle)
    expect(briefing[0]).toMatchObject({ entity: { namespace: 'order', id: 'order_1' } })

    const account = extractAgentReferences('get_trading_account_detail', {
      data: { account: { id: 'account_1' }, recentTrades: [{ id: 'trade_1', tradingAccountId: 'account_1' }] },
    }, trading)
    expect(account.map((ref) => ref.entity?.namespace).sort()).toEqual(['trade', 'trading_account'])
  })

  it('keeps customer, product, growth, and media identities in their exact namespaces', () => {
    const customers = extractAgentReferences('get_customer_segments', {
      data: { winBack: [{ id: 'cs_customer_1' }], loyal: [{ id: 'cs_customer_2' }] },
    }, lifestyle)
    expect(customers.map((ref) => ref.entity?.namespace)).toEqual(['cs_customer', 'cs_customer'])

    const product = extractAgentReferences('get_product_details', {
      data: {
        code: 'SKU-1',
        variants: [{ id: 'stock_item_1', size: 'M', stock: 2 }],
      },
    }, lifestyle)
    expect(product).toHaveLength(1)
    expect(product[0]).toMatchObject({ entity: { namespace: 'product', id: 'SKU-1' } })
    expect(product.some((ref) => ref.entity?.namespace === 'variant' || ref.entity?.namespace === 'stock_item')).toBe(false)

    const catalogGroup = extractAgentReferences('get_product', {
      data: { products: [{ sku: '720', source: 'image-catalog', members: ['720-ADULT'] }] },
    }, lifestyle)
    expect(catalogGroup).toHaveLength(1)
    expect(catalogGroup[0]).toMatchObject({ kind: 'internal_section', destination: { sectionId: 'inventory' } })

    const growth = extractAgentReferences('growth_brief_get', {
      data: { history: [{ id: 'brief_1' }, { id: 'brief_2' }] },
    }, lifestyle)
    expect(growth.map((ref) => ref.entity?.namespace)).toEqual(['growth_recommendation', 'growth_recommendation'])

    const media = extractAgentReferences('plan_media_video', {
      data: { projectId: 'media_1', pendingActionId: 'pending_media_1' },
    }, lifestyle)
    expect(media.map((ref) => ref.entity?.namespace).sort()).toEqual(['agent_pending_action', 'media_project'])
  })

  it('never mints employee/profile refs from unrelated User ids', () => {
    const accounts = extractAgentReferences('get_trading_accounts', {
      data: { accounts: [{ id: 'account_1', assignedStaff: { id: 'user_1' } }] },
    }, trading)
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({ entity: { namespace: 'trading_account', id: 'account_1' } })

    const reports = extractAgentReferences('get_trading_employee_reports', {
      data: { rows: [{ userId: 'user_1', accountIds: ['account_1'] }] },
    }, trading)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ entity: { namespace: 'trading_account', id: 'account_1' } })
  })

  it('does not recursively scan arbitrary ids or turn a generic list into an exact claim', () => {
    const section = extractAgentReferences('get_dashboard_snapshot', {
      data: { nested: { id: 'looks_linkable', url: 'https://evil.example' } },
    }, lifestyle)
    expect(section).toHaveLength(1)
    expect(section[0].kind).toBe('internal_section')

    expect(extractAgentReferences('get_current_datetime', {
      data: { nested: { id: 'not_a_record' } },
    }, lifestyle)).toEqual([])
  })

  it('propagates top-level delegated metadata, revalidates context, and obeys kill switch', () => {
    const valid = buildInternalEntityReference({
      namespace: 'order', id: 'ord_2', label: 'AL-2', sourceTool: 'get_orders',
      outputPath: 'data.orders[0].id', context: lifestyle,
    })!
    const records = [{
      toolName: 'delegate_to_specialist',
      output: { data: { summary: 'done' }, references: [valid] },
      status: 'success',
    }]

    process.env.AGENT_REFERENCES_ROLLOUT = 'shadow'
    expect(extractAgentReferencesFromRecords(records, lifestyle)).toEqual([valid])
    expect(extractAgentReferencesFromRecords(records, trading)).toEqual([])

    process.env.AGENT_REFERENCES_ROLLOUT = 'off'
    expect(extractAgentReferencesFromRecords(records, lifestyle)).toEqual([])
    process.env.AGENT_REFERENCES_ROLLOUT = 'on'
    process.env.AGENT_REFERENCES_KILL_SWITCH = 'true'
    expect(extractAgentReferencesFromRecords(records, lifestyle)).toEqual([])
  })
})
