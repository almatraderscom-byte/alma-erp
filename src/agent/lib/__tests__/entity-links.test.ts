import { describe, expect, it } from 'vitest'
import {
  enrichToolResultWithEntityLinks,
  extractAgentEntityLinks,
  extractAgentEntityLinksFromRecords,
  linkifyAgentEntityText,
} from '@/agent/lib/entity-links'

describe('verified agent entity links', () => {
  it('extracts exact order IDs and keeps the human order number as the label', () => {
    const links = extractAgentEntityLinks('get_orders', {
      data: {
        orders: [
          { id: 'ord_123', orderNumber: 'ALM-9081', customerId: 'never-link-me' },
          { id: '../../escape', orderNumber: 'BAD-1' },
        ],
      },
    })

    expect(links).toEqual([
      expect.objectContaining({
        entityType: 'order',
        entityId: 'ord_123',
        label: '#ALM-9081',
        businessId: 'ALMA_LIFESTYLE',
        href: '/orders/ord_123?business_id=ALMA_LIFESTYLE',
      }),
    ])
  })

  it('uses exact orderEntities from the issue scan, never ambiguous display refs', () => {
    const links = extractAgentEntityLinks('check_order_issues', {
      data: {
        issues: [
          {
            orders: ['ALM-9081', 'ALM-9082'],
            orderEntities: [{ id: 'db-order-1', orderNumber: 'ALM-9081' }],
          },
        ],
      },
    })

    expect(links.map((link) => link.href)).toEqual(['/orders/db-order-1?business_id=ALMA_LIFESTYLE'])
    expect(extractAgentEntityLinks('check_order_issues', {
      data: { issues: [{ orders: ['ALM-9081'] }] },
    })).toEqual([])
  })

  it('only treats ERP rows from customer order status as navigable orders', () => {
    const links = extractAgentEntityLinks('get_customer_order_status', {
      data: {
        orders: [
          { source: 'cs_draft', id: 'draft-1' },
          { source: 'erp', id: 'erp-order-1' },
        ],
      },
    })

    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ entityId: 'erp-order-1', href: '/orders/erp-order-1?business_id=ALMA_LIFESTYLE' })
  })

  it('supports verified employee and trading-account detail routes', () => {
    const links = extractAgentEntityLinksFromRecords([
      {
        toolName: 'get_attendance',
        status: 'success',
        output: {
          data: {
            businessId: 'ALMA_LIFESTYLE',
            present: [{ employeeId: 'EMP-7', name: 'Eyafi' }],
          },
        },
      },
      {
        toolName: 'get_trading_accounts',
        status: 'success',
        output: {
          data: {
            accounts: [{
              id: 'acct_9',
              accountTitle: 'Main Binance',
              assignedStaff: { id: 'user-not-an-employee-route', name: 'Someone' },
            }],
          },
        },
      },
    ])

    expect(links).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: 'employee', businessId: 'ALMA_LIFESTYLE', href: '/employees/EMP-7?business_id=ALMA_LIFESTYLE' }),
      expect.objectContaining({ entityType: 'trading_account', businessId: 'ALMA_TRADING', href: '/trading/accounts/acct_9?business_id=ALMA_TRADING' }),
    ]))
    expect(links.some((link) => link.entityId === 'user-not-an-employee-route')).toBe(false)
  })

  it('does not cross-link attendance from a different employee namespace', () => {
    for (const businessId of ['ALMA_TRADING', 'CREATIVE_DIGITAL_IT']) {
      expect(extractAgentEntityLinks('get_attendance', {
        data: {
          businessId,
          present: [{ employeeId: 'EMP-7', name: 'Wrong roster' }],
        },
      })).toEqual([])
    }
  })

  it('does not invent routes for unknown tools or unsupported entities', () => {
    for (const toolName of [
      'get_customer_intelligence',
      'get_product',
      'get_pending_approvals',
      'get_projects',
      'anything_else',
    ]) {
      expect(extractAgentEntityLinks(toolName, {
        data: { id: 'looks-real', customers: [{ id: 'customer-1' }], products: [{ id: 'product-1' }] },
      })).toEqual([])
    }
  })

  it('enriches the shared tool-result envelope without a provider dependency', () => {
    const result = enrichToolResultWithEntityLinks('get_employee_overview', {
      success: true,
      data: { employees: [{ id: 'EMP-2', name: 'Mustahid' }] },
    })

    expect(result.entityLinks?.[0]).toMatchObject({ href: '/employees/EMP-2?business_id=ALMA_LIFESTYLE' })
  })

  it('carries only canonical specialist links through the explicit delegation field', () => {
    const links = extractAgentEntityLinks('delegate_to_specialist', {
      data: {
        entityLinks: [
          {
            entityType: 'order',
            entityId: 'db-order-1',
            businessId: 'ALMA_LIFESTYLE',
            label: '#ALM-9081',
            href: '/orders/db-order-1?business_id=ALMA_LIFESTYLE',
            aliases: ['ALM-9081'],
          },
          {
            entityType: 'order',
            entityId: 'db-order-2',
            businessId: 'ALMA_LIFESTYLE',
            label: '#ALM-9082',
            href: '/orders/invented-route',
          },
        ],
        // Lookalike nested IDs are not an extractor path.
        finding: { id: 'db-order-3', orderNumber: 'ALM-9083' },
      },
    })

    expect(links).toEqual([
      expect.objectContaining({ entityId: 'db-order-1', href: '/orders/db-order-1?business_id=ALMA_LIFESTYLE' }),
    ])
  })

  it('filters verified metadata by the server-resolved business context', () => {
    const orderOutput = {
      data: { orderEntities: [{ id: 'db-order-1', orderNumber: 'ALM-9081' }] },
    }
    const tradingOutput = {
      data: { accounts: [{ id: 'acct-1', accountTitle: 'Main Binance' }] },
    }

    expect(extractAgentEntityLinks('update_order', orderOutput, {
      businessId: 'ALMA_TRADING',
    })).toEqual([])
    expect(extractAgentEntityLinks('get_trading_accounts', tradingOutput, {
      businessId: 'ALMA_LIFESTYLE',
    })).toEqual([])
    expect(extractAgentEntityLinks('update_order', orderOutput, {
      businessId: 'ALMA_LIFESTYLE',
    })).toEqual([
      expect.objectContaining({ href: '/orders/db-order-1?business_id=ALMA_LIFESTYLE' }),
    ])

    const delegatedInTrading = enrichToolResultWithEntityLinks('delegate_to_specialist', {
      success: true,
      data: {
        entityLinks: [{
          entityType: 'order' as const,
          entityId: 'db-order-1',
          businessId: 'ALMA_LIFESTYLE' as const,
          label: '#ALM-9081',
          href: '/orders/db-order-1?business_id=ALMA_LIFESTYLE',
        }],
      },
    }, { businessId: 'ALMA_TRADING' })
    expect(delegatedInTrading.entityLinks).toBeUndefined()
  })

  it('extracts exact standardized order refs from write and lifecycle tools', () => {
    for (const toolName of ['update_order', 'update_orders', 'order_lifecycle_scan']) {
      expect(extractAgentEntityLinks(toolName, {
        data: {
          orderId: 'ambiguous-top-level-id',
          orderEntities: [{ id: 'db-order-1', orderNumber: 'ALM-9081' }],
        },
      })).toEqual([
        expect.objectContaining({
          entityId: 'db-order-1',
          label: '#ALM-9081',
          href: '/orders/db-order-1?business_id=ALMA_LIFESTYLE',
        }),
      ])
    }
  })
})

describe('deterministic Markdown entity linkification', () => {
  const order = extractAgentEntityLinks('get_orders', {
    data: { orders: [{ id: 'ord_123', orderNumber: 'ALM-9081' }] },
  })[0]

  it('links an exact mention and is idempotent', () => {
    const once = linkifyAgentEntityText('অর্ডার ALM-9081 এখন pending।', [order], {
      appendUnmentioned: true,
    })
    const twice = linkifyAgentEntityText(once, [order], { appendUnmentioned: true })

    expect(once).toBe('অর্ডার [ALM-9081](/orders/ord_123?business_id=ALMA_LIFESTYLE) এখন pending।')
    expect(twice).toBe(once)
  })

  it('does not rewrite fenced code, inline code, or an existing Markdown link', () => {
    const input = [
      '`ALM-9081` raw value',
      '',
      '```json',
      '{"order":"ALM-9081"}',
      '```',
      '',
      'খুলুন: [ALM-9081](/orders/ord_123?business_id=ALMA_LIFESTYLE)',
    ].join('\n')

    const output = linkifyAgentEntityText(input, [order], { appendUnmentioned: true })
    expect(output).toBe(input)
    expect(output.match(/\/orders\/ord_123/g)).toHaveLength(1)
  })

  it('an unrelated citation or invented route cannot suppress the verified fallback', () => {
    const input = 'Source: [report](https://example.com) · [wrong order](/orders/fake)'
    const output = linkifyAgentEntityText(input, [order], { appendUnmentioned: true })

    expect(output).toContain(input)
    expect(output).toContain('[#ALM-9081](/orders/ord_123?business_id=ALMA_LIFESTYLE)')
    expect(output.match(/\/orders\/ord_123/g)).toHaveLength(1)
  })

  it('leaves an unclosed code fence untouched instead of injecting a broken link', () => {
    const input = '```json\n{"order":"ALM-9081"}'
    expect(linkifyAgentEntityText(input, [order], { appendUnmentioned: true })).toBe(input)
  })

  it('has an append-only late-convergence mode for already streamed prose', () => {
    const input = 'বস, অর্ডার ALM-9081-এ সমস্যা আছে।'
    const output = linkifyAgentEntityText(input, [order], {
      appendUnmentioned: true,
      linkMentions: false,
    })

    expect(output.startsWith(input)).toBe(true)
    expect(output).toContain('[#ALM-9081](/orders/ord_123?business_id=ALMA_LIFESTYLE)')
  })

  it('leaves a duplicate human name plain and links only an explicit stable id', () => {
    const employees = extractAgentEntityLinks('get_employee_overview', {
      data: {
        employees: [
          { id: 'EMP-1', name: 'Alex' },
          { id: 'EMP-2', name: 'Alex' },
        ],
      },
    })

    expect(linkifyAgentEntityText('Alex আজ absent; EMP-2 late.', employees)).toBe(
      'Alex আজ absent; [EMP-2](/employees/EMP-2?business_id=ALMA_LIFESTYLE) late.',
    )
  })

  it('selects non-overlapping matches from the original prose with longest alias first', () => {
    const employees = extractAgentEntityLinks('get_employee_overview', {
      data: {
        employees: [
          { id: 'EMP-1', name: 'Alex Khan' },
          { id: 'EMP-2', name: 'Alex' },
        ],
      },
    })

    expect(linkifyAgentEntityText('Alex Khan এবং Alex available.', employees)).toBe(
      '[Alex Khan](/employees/EMP-1?business_id=ALMA_LIFESTYLE) এবং [Alex](/employees/EMP-2?business_id=ALMA_LIFESTYLE) available.',
    )
  })
})
