/**
 * B1 — the ERP's first write.
 *
 * Counted from `capability-classification.ts` on 2026-07-27: ERP had 19 read
 * tools and ZERO writes, so every "handle this order" request died there. These
 * pin the shape that makes the first one safe: it is staged, never silent; it
 * says what a status word does to stock; and it refuses the two things that
 * would make a card a lie — an unknown status, and a change that is not a
 * change.
 */
import { describe, it, expect } from 'vitest'
import { ERP_TOOLS } from '@/agent/tools/erp-tools'
import { TOOL_CLASSIFICATION } from '@/agent/tools/capability-classification'
import { DOMAIN_PACKS } from '@/agent/tools/state-router'

const tool = ERP_TOOLS.find((t) => t.name === 'update_order')!

describe('update_order is registered and staged', () => {
  it('exists on the ERP tool set', () => {
    expect(tool).toBeTruthy()
  })

  it('needs only the order — every field is optional', () => {
    expect(tool.input_schema.required).toEqual(['orderNumber'])
  })

  it('covers status, courier, tracking and the note', () => {
    const props = Object.keys(tool.input_schema.properties ?? {})
    for (const field of ['status', 'courier', 'trackingId', 'notes']) {
      expect(props).toContain(field)
    }
  })

  it('keeps money out — a price change is not an order status change', () => {
    const props = Object.keys(tool.input_schema.properties ?? {})
    for (const field of ['price', 'unitPrice', 'discount', 'cogs']) {
      expect(props).not.toContain(field)
    }
    expect(tool.description).toMatch(/Money fields .* are NOT editable/i)
  })

  it('warns the head that cancel and return move stock', () => {
    expect(tool.description).toMatch(/restore stock/i)
  })

  it('promises the read-back, because the card is what the owner trusts', () => {
    expect(tool.description).toMatch(/read back from the ERP/i)
  })

  it('is classified as a staged ERP change', () => {
    const entry = TOOL_CLASSIFICATION.update_order
    expect(entry).toBeTruthy()
    expect(entry.domain).toBe('erp')
    expect(entry.mode).toBe('stage')
  })

  // The lesson from A3 and A1, as a test: a tool nobody names is invisible.
  it('is named by every allowlist that has to see it', () => {
    expect(DOMAIN_PACKS.erp).toContain('update_order')
  })
})

describe('the gates, before the owner is ever asked', () => {
  it('refuses an empty order reference', async () => {
    const res = await tool.handler({ orderNumber: '   ', status: 'shipped' })
    expect(res.success).toBe(false)
  })

  // No DATABASE_URL in unit tests, so this exercises the failure path rather
  // than a real lookup — what it pins is that a lookup problem NEVER becomes a
  // staged card. Nothing is proposed to the owner for an order we could not read.
  it('never stages anything when the order cannot be read', async () => {
    const res = await tool.handler({ orderNumber: 'NOPE-99312', status: 'shipped' })
    expect(res.success).toBe(false)
    expect(res.data).toBeUndefined()
  })

  it('takes the order the way Boss says it — a number, not an internal id', () => {
    const orderNumber = (tool.input_schema.properties as Record<string, { description?: string }>).orderNumber
    expect(orderNumber?.description).toMatch(/invoice number/i)
  })
})

/**
 * Caught on the card, one click before it landed (2026-07-31).
 *
 * This ERP stores a machine-readable `ORDER_ITEMS_JSON:{…}` payload — every line
 * item, size, price and COGS — in the same `notes` column a human note goes in.
 * The first version replaced that field, so a one-sentence note would have
 * deleted the order's items. The card is what made it visible; these keep it
 * impossible.
 */
describe('the note is added, never substituted', () => {
  it('says so in the schema, where the head reads it', () => {
    const notes = (tool.input_schema.properties as Record<string, { description?: string }>).notes
    expect(notes?.description).toMatch(/appended/i)
    expect(notes?.description).toMatch(/never replaced/i)
  })

  it('tells the head not to narrate its own change into the order', () => {
    const notes = (tool.input_schema.properties as Record<string, { description?: string }>).notes
    expect(notes?.description).toMatch(/do not narrate/i)
  })
})

/**
 * Review-bot round 1 on #661. Three P1s and three P2s, all of them about the
 * difference between writing a row and changing an order.
 */
describe('the ERP status vocabulary is the ERP’s, not the model’s', () => {
  it('offers "processing" but the ERP word for it is Packed', async () => {
    const { normalizeOrderStatus, VALID_ORDER_STATUSES } = await import('@/lib/lifestyle/order-status-workflow')
    // The status list the head sees still contains the word it would say…
    const statuses = (tool.input_schema.properties as Record<string, { enum?: string[] }>).status?.enum ?? []
    expect(statuses).toContain('processing')
    // …and it never reaches the database in that form.
    expect(normalizeOrderStatus('processing')).toBe('Packed')
    expect(VALID_ORDER_STATUSES.has(normalizeOrderStatus('processing'))).toBe(true)
  })

  it('normalises every offered status to something the ERP stores', async () => {
    const { normalizeOrderStatus, VALID_ORDER_STATUSES } = await import('@/lib/lifestyle/order-status-workflow')
    const statuses = (tool.input_schema.properties as Record<string, { enum?: string[] }>).status?.enum ?? []
    for (const s of statuses) {
      expect(VALID_ORDER_STATUSES.has(normalizeOrderStatus(s))).toBe(true)
    }
  })

  it('treats cancelled and returned as final', async () => {
    const { isTerminalOrderStatus } = await import('@/lib/lifestyle/order-status-workflow')
    for (const s of ['CANCELLED', 'RETURNED', 'RETURNED_PAID', 'RETURNED_UNPAID']) {
      expect(isTerminalOrderStatus(s)).toBe(true)
    }
    for (const s of ['Pending', 'Shipped', 'Delivered', 'Packed']) {
      expect(isTerminalOrderStatus(s)).toBe(false)
    }
  })
})

/**
 * B5 — one card per JOB, not per item.
 *
 * "ei tin ta order shipped kore dao" was three separate approvals, which is the
 * friction the whole "I just approve" goal keeps meeting. A batch card carries
 * the same per-order payload N times and runs the SAME executor for each, so a
 * batch of ten cannot behave differently from a batch of one.
 */
describe('update_orders — many orders, one approval', () => {
  const batch = ERP_TOOLS.find((t) => t.name === 'update_orders')!

  it('exists and takes a list of orders', () => {
    expect(batch).toBeTruthy()
    expect(batch.input_schema.required).toEqual(['orders'])
  })

  it('each entry carries its own fields — a batch is not one change repeated', () => {
    const items = (batch.input_schema.properties as Record<string, { items?: { properties?: Record<string, unknown>; required?: string[] } }>).orders?.items
    expect(items?.required).toEqual(['orderNumber'])
    for (const field of ['status', 'courier', 'trackingId', 'notes']) {
      expect(Object.keys(items?.properties ?? {})).toContain(field)
    }
  })

  it('promises a per-order read-back, so a partial batch names the order that failed', () => {
    expect(batch.description).toMatch(/read back from the ERP/i)
    expect(batch.description).toMatch(/WHICH order/i)
  })

  it('is classified and allowlisted like its single sibling', () => {
    expect(TOOL_CLASSIFICATION.update_orders?.mode).toBe('stage')
    expect(TOOL_CLASSIFICATION.update_orders?.domain).toBe('erp')
    expect(DOMAIN_PACKS.erp).toContain('update_orders')
  })

  it('refuses an empty list rather than staging an empty card', async () => {
    const res = await batch.handler({ orders: [] })
    expect(res.success).toBe(false)
  })

  it('caps the batch at a size a person can actually read', async () => {
    const res = await batch.handler({
      orders: Array.from({ length: 40 }, (_, i) => ({ orderNumber: `AL-${i}`, status: 'shipped' })),
    })
    expect(res.success).toBe(false)
    expect(String(res.error)).toMatch(/১৫|15/)
  })
})

/**
 * Live on 2026-07-31: the batch wrote `steadfast` (lowercase) onto two orders
 * while 313 others sat on `Pathao`. A courier is a name the rest of the ERP
 * matches on — a filter, a report and a dropdown all treat the two as different
 * couriers.
 */
describe('a courier is spelled the ERP’s way', () => {
  const batch = ERP_TOOLS.find((t) => t.name === 'update_orders')!

  it('offers only the ERP’s own courier names', () => {
    const single = (tool.input_schema.properties as Record<string, { enum?: string[] }>).courier?.enum ?? []
    expect(single).toContain('Steadfast')
    expect(single).toContain('Pathao')
    expect(single).not.toContain('steadfast')
  })

  it('offers the same list on the batch tool', () => {
    const items = (batch.input_schema.properties as Record<string, { items?: { properties?: Record<string, { enum?: string[] }> } }>).orders?.items
    expect(items?.properties?.courier?.enum).toContain('Steadfast')
  })
})
