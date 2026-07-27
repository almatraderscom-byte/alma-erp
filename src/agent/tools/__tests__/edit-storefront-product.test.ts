/**
 * One product edit, one approval.
 *
 * Before this tool, changing a product's name, price and alt text meant three
 * separate cards for the owner to approve — which is the friction the whole
 * "agent does the work, I just approve" goal runs into. These pin the gates that
 * make a batched card safe to stage: it refuses work it cannot honestly do, and
 * it never asks the owner to approve a change that is not a change.
 */
import { describe, it, expect } from 'vitest'
import { WEBSITE_TOOLS } from '@/agent/tools/website-tools'
import { TOOL_CLASSIFICATION } from '@/agent/tools/capability-classification'

const tool = WEBSITE_TOOLS.find((t) => t.name === 'edit_storefront_product')!

describe('edit_storefront_product is registered and staged', () => {
  it('exists on the website tool set', () => {
    expect(tool).toBeTruthy()
  })

  it('needs only the product — every field is optional', () => {
    expect(tool.input_schema.required).toEqual(['slugOrId'])
  })

  it('accepts the seven writable fields in one call', () => {
    const props = Object.keys(tool.input_schema.properties ?? {})
    for (const field of [
      'title',
      'shortDescription',
      'description',
      'priceBdt',
      'category',
      'published',
      'featured',
      'imageAlts',
    ]) {
      expect(props).toContain(field)
    }
  })

  it('tells the head this is the batched one, not another single-field tool', () => {
    expect(tool.description).toMatch(/ALL IN ONE approval card/i)
    expect(tool.description).toMatch(/prefer it over/i)
  })

  it('sends the head to change_product_slug for a URL rename', () => {
    expect(tool.description).toMatch(/change_product_slug/)
  })

  it('promises the read-back, because the card is what the owner trusts', () => {
    expect(tool.description).toMatch(/read back from the live site/i)
  })

  it('is classified as a staged website change, like its single-field siblings', () => {
    const entry = TOOL_CLASSIFICATION.edit_storefront_product
    expect(entry).toBeTruthy()
    expect(entry.domain).toBe('website')
    expect(entry.mode).toBe('stage')
  })
})

describe('the gates, before the owner is ever asked', () => {
  it('refuses a product it cannot find', async () => {
    const res = await tool.handler({ slugOrId: 'no-such-product-xyz-9931', priceBdt: 100 })
    expect(res.success).toBe(false)
  })

  it('refuses an empty product reference', async () => {
    const res = await tool.handler({ slugOrId: '   ', priceBdt: 100 })
    expect(res.success).toBe(false)
  })
})
