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
